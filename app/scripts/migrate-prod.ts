/**
 * Production migration entrypoint. Runs as the PRIVILEGED migrator role, which
 * owns the tables. The application connects separately as a non-superuser that
 * does not own them — otherwise Row-Level Security is bypassed silently.
 * See src/db/rls.ts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { allSecuritySql, tenantScopedTables } from '../src/db/rls.js';
import { migrationsDir } from '../src/db/migrate.js';

const configured = process.env.DATABASE_URL;
if (typeof configured !== 'string' || configured.length === 0) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(1);
}
const url: string = configured;

const log = (m: string): void => { process.stdout.write(`[migrate] ${m}\n`); };

async function main(): Promise<void> {
  const sql = postgres(url, { max: 1 });
  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  log(`${files.length} migration file(s) from ${dir}`);

  for (const file of files) {
    const statements = readFileSync(join(dir, file), 'utf8')
      .split('\n--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) await sql.unsafe(statement);
    log(`applied ${file} (${statements.length} statements)`);
  }

  await sql.unsafe(allSecuritySql());
  log('roles, RLS policies and audit immutability triggers installed');

  const roles = await sql`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'coldpath_app'`;
  const r = roles[0];
  if (r === undefined) throw new Error('coldpath_app role was not created');
  if (r.rolsuper === true || r.rolbypassrls === true) {
    throw new Error('coldpath_app must be non-superuser without BYPASSRLS — RLS would be bypassed');
  }
  log(`coldpath_app verified: superuser=${String(r.rolsuper)} bypassrls=${String(r.rolbypassrls)}`);

  // Count the policies AND assert the count. This used to log the number and
  // exit 0 regardless — so a migration that installed zero tenant_isolation
  // policies deployed green, and the one script whose entire purpose is refusing
  // to ship broken isolation would have shipped it, printing "policies: 0" into
  // a log nobody reads until the incident.
  const expected = tenantScopedTables();
  const pol = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation'`;
  const covered = new Set(pol.map((r) => r.tablename));
  const missing = expected.filter((t) => !covered.has(t));
  if (missing.length > 0) {
    throw new Error(
      `tenant_isolation missing on ${missing.length} of ${expected.length} tenant-scoped ` +
      `table(s): ${missing.join(', ')} — refusing to complete, tenancy isolation is not in force`,
    );
  }
  log(`tenant_isolation verified on all ${expected.length} tenant-scoped tables`);

  // ENABLE alone is not enough: without FORCE, the table OWNER bypasses the
  // policy. Migrations run as the owner, so this is the exact role that must not
  // be able to read across tenants if it is ever reused for the application.
  const unforced = await sql<{ relname: string }[]>`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname = ANY(${expected})
       AND (c.relrowsecurity IS NOT TRUE OR c.relforcerowsecurity IS NOT TRUE)`;
  if (unforced.length > 0) {
    throw new Error(
      `RLS not ENABLEd+FORCEd on: ${unforced.map((r) => r.relname).join(', ')}`,
    );
  }
  log('row-level security enabled and forced on every tenant-scoped table');

  await sql.end();
  log('done');
}

main().catch((e: unknown) => {
  process.stderr.write(`[migrate] FAILED: ${String(e)}\n`);
  process.exit(1);
});
