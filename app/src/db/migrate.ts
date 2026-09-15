import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import * as schema from './schema/index.js';
import { allSecuritySql, tenantScopedTables } from './rls.js';

// migrationsDir() lives in migrations-dir.ts so that scripts/migrate-prod.ts
// can locate migrations WITHOUT importing a database driver. Re-exported here
// for the dev/test callers that already import it from this module.
export { migrationsDir, MIGRATIONS_DIR } from './migrations-dir.js';
import { MIGRATIONS_DIR } from './migrations-dir.js';

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
