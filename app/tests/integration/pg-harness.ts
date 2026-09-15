import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '../../src/db/schema/index.js';
import { account, tenant } from '../../src/db/schema/index.js';
import { allSecuritySql, tenantScopedTables } from '../../src/db/rls.js';
import { migrationsDir } from '../../src/db/migrations-dir.js';
import type { Db } from '../../src/db/client.js';
import { TENANT_A, TENANT_B, type Harness } from './harness.js';

/**
 * The same harness, against a REAL Postgres server instead of PGlite.
 *
 * Why this exists: every isolation proof in this repo ran on PGlite, an
 * in-process WASM build of Postgres 18.3, while production targets Postgres 16.
 * Testing on a newer major than you ship is a gap, and RLS is exactly the kind
 * of feature where the gap could matter — role handling, FORCE semantics and
 * policy evaluation are engine behaviour, not application behaviour. CI already
 * started a Postgres 16 service and then never used it.
 *
 * rls.checks.ts and auth.checks.ts are untouched by this file. They take a
 * `Harness`, which is engine-agnostic, so the identical assertions run on both
 * engines and any divergence shows up as a failing check rather than as a
 * difference nobody looked for.
 *
 * Connects as the MIGRATOR role (DATABASE_URL). That is deliberate and mirrors
 * production: the migrator owns the tables, and `withTenant()` does
 * `SET LOCAL ROLE coldpath_app` to drop into the non-owning, NOBYPASSRLS role
 * for every tenant-scoped statement. It is also what makes the negative control
 * meaningful — the owner/superuser genuinely does see everything.
 */
export async function setupPgHarness(databaseUrl: string): Promise<Harness> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });

  // A clean slate per run: CI reuses the same service across steps, and a
  // half-migrated schema would produce assertion failures that look like
  // isolation bugs.
  await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');

  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error(`no migrations found in ${dir}`);
  for (const file of files) {
    const statements = readFileSync(join(dir, file), 'utf8')
      .split('\n--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) await client.unsafe(statement);
  }

  await client.unsafe(allSecuritySql());

  // Same verification migrate-prod.ts performs: if the app role could bypass
  // RLS, every isolation assertion below would pass while proving nothing.
  const roles = await client.unsafe(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'coldpath_app'`,
  ) as unknown as { rolsuper: boolean; rolbypassrls: boolean }[];
  const appRole = roles[0];
  if (appRole === undefined) throw new Error('coldpath_app role was not created');
  if (appRole.rolsuper || appRole.rolbypassrls) {
    throw new Error('coldpath_app must be non-superuser without BYPASSRLS');
  }

  // Confirm RLS is enabled AND forced, engine-side, before asserting anything.
  const rls = await client.unsafe(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  ) as unknown as { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[];
  const secured = tenantScopedTables();
  for (const t of secured) {
    const row = rls.find((r) => r.relname === t);
    if (!row?.relrowsecurity || !row.relforcerowsecurity) {
      throw new Error(`RLS not enabled+forced on ${t}`);
    }
  }

  const db = drizzle(client, { schema }) as unknown as Db;

  const [a] = await db.insert(tenant).values({ id: TENANT_A, name: 'Ndustrial', slug: 'ndustrial' }).returning();
  const [b] = await db.insert(tenant).values({ id: TENANT_B, name: 'Competitor Co', slug: 'competitor' }).returning();
  if (!a || !b) throw new Error('tenant seeding failed');

  await db.insert(account).values([
    { tenantId: a.id, canonicalName: 'Americold Realty Trust', isCustomer: true, icpScore: 97 },
    { tenantId: a.id, canonicalName: 'Sysco Corporation', isCustomer: false, icpScore: 94 },
    { tenantId: b.id, canonicalName: 'Tenant B Secret Customer', isCustomer: true, icpScore: 99 },
  ]);

  const tables = await client.unsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  ) as unknown as { tablename: string }[];

  return {
    db,
    // postgres.js returns rows directly; PGlite wraps them in { rows }. The
    // checks are written against the PGlite shape, so match it here.
    raw: {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
      query: async <T>(text: string): Promise<{ rows: T[] }> => ({
        rows: (await client.unsafe(text)) as unknown as T[],
      }),
    },
    tenantAId: a.id,
    tenantBId: b.id,
    tables: tables.length,
    securedTables: secured,
    close: async () => { await client.end(); },
  };
}
