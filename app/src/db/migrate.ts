import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import * as schema from './schema/index.js';
import { allSecuritySql, tenantScopedTables } from './rls.js';

/**
 * Locate the migrations directory.
 *
 * .sql files are not emitted by tsc, so the compiled layout (dist/src/db/) does
 * not contain them. Walk up from this module looking for a migrations folder
 * beside a src/db directory, which resolves identically from source and from
 * dist. Override with COLDPATH_MIGRATIONS_DIR when deploying.
 */
export function migrationsDir(): string {
  const override = process.env.COLDPATH_MIGRATIONS_DIR;
  if (override) {
    if (!existsSync(override)) throw new Error(`COLDPATH_MIGRATIONS_DIR does not exist: ${override}`);
    return override;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'src', 'db', 'migrations');
    if (existsSync(candidate)) return candidate;
    const local = join(dir, 'migrations');
    if (existsSync(local) && readdirSync(local).some((f) => f.endsWith('.sql'))) return local;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate a migrations directory from ${dirname(fileURLToPath(import.meta.url))}`);
}

export const MIGRATIONS_DIR = resolve(migrationsDir());

export interface MigratedDb {
  db: PgliteDatabase<typeof schema>;
  raw: PGlite;
  tables: number;
  securedTables: string[];
}

/**
 * Applies every .sql migration in order, then the security layer.
 *
 * The security SQL is deliberately NOT a generated migration: drizzle-kit does
 * not model roles or RLS policies, and keeping them separate means regenerating
 * a schema migration can never silently drop tenancy isolation.
 */
export async function migratePglite(raw: PGlite): Promise<MigratedDb> {
  const db = drizzle(raw, { schema });

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) throw new Error(`no migrations found in ${MIGRATIONS_DIR}`);

  for (const file of files) {
    const statements = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      .split('\n--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) await raw.exec(statement);
  }

  await raw.exec(allSecuritySql());

  const tables = await raw.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const secured = tenantScopedTables();

  // Verify RLS is actually on. If this ever passes while isolation is broken,
  // the check itself is wrong — hence the negative control in the test suite.
  const rls = await raw.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  );
  for (const t of secured) {
    const row = rls.rows.find((r) => r.relname === t);
    if (!row?.relrowsecurity || !row.relforcerowsecurity) {
      throw new Error(`RLS not enabled+forced on ${t}`);
    }
  }

  return { db, raw, tables: tables.rows.length, securedTables: secured };
}
