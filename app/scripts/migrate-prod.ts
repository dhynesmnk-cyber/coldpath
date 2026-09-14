/**
 * Production migration entrypoint. Runs as the PRIVILEGED migrator role, which
 * owns the tables. The application connects separately as a non-superuser that
 * does not own them — otherwise Row-Level Security is bypassed silently.
 * See src/db/rls.ts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { allSecuritySql } from '../src/db/rls.js';
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

  const pol = await sql`SELECT count(*)::int AS c FROM pg_policies WHERE policyname = 'tenant_isolation'`;
  log(`tenant_isolation policies: ${String(pol[0]?.c ?? 0)}`);
  await sql.end();
  log('done');
}

main().catch((e: unknown) => {
  process.stderr.write(`[migrate] FAILED: ${String(e)}\n`);
  process.exit(1);
});
