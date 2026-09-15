/**
 * The integration verifier, run against a REAL Postgres server.
 *
 * verify-integration.ts proves the RLS and AUTH-SPEC §12 assertions against
 * PGlite — an in-process WASM Postgres 18.3. Production targets Postgres 16.
 * Those are different majors, and tenancy isolation is engine behaviour: role
 * handling, FORCE ROW LEVEL SECURITY semantics and policy evaluation live in
 * the server, not in this codebase. Proving them only on the newer engine is
 * evidence about the wrong thing.
 *
 * So this script runs the IDENTICAL checks — the same rlsChecks and authChecks
 * arrays, not a parallel copy — through a postgres.js connection. Any
 * divergence between the two engines surfaces as a failing assertion.
 *
 * Requires DATABASE_URL pointing at a server whose role owns the schema.
 *
 *   npm run build && DATABASE_URL=postgres://... node dist/scripts/verify-postgres.js
 */
import { setupPgHarness } from '../tests/integration/pg-harness.js';
import { rlsChecks, type Check } from '../tests/integration/rls.checks.js';
import { authChecks } from '../tests/integration/auth.checks.js';

const out = (s: string): void => { process.stdout.write(s + '\n'); };

const configured = process.env.DATABASE_URL;
if (typeof configured !== 'string' || configured.length === 0) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(1);
}
const databaseUrl: string = configured;

async function main(): Promise<number> {
  const t0 = Date.now();
  out('COLDPATH integration verifier — REAL POSTGRES');
  out('='.repeat(58));

  const h = await setupPgHarness(databaseUrl);
  const { rows: versionRows } = await h.raw.query<{ version: string }>('SELECT version()');
  const version = versionRows[0];
  out(`  ${version?.version.split(',')[0] ?? 'unknown server'}`);
  out(`  harness ready in ${Date.now() - t0}ms — ${h.tables} tables, ${h.securedTables.length} RLS-secured\n`);

  let pass = 0;
  let fail = 0;

  const runSuite = async (title: string, checks: readonly Check[]): Promise<void> => {
    out(`  ── ${title} ──`);
    let group = '';
    for (const check of checks) {
      if (check.group !== group) { group = check.group; out(`  ${group}`); }
      const t = Date.now();
      try {
        await check.run(h);
        pass += 1;
        out(`    ok    ${check.name}  (${Date.now() - t}ms)`);
      } catch (err) {
        fail += 1;
        out(`    FAIL  ${check.name}`);
        out(`          ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    out('');
  };

  await runSuite('RLS + tenancy', rlsChecks);
  await runSuite('AUTH-SPEC §12 acceptance', authChecks);

  await h.close();

  const total = pass + fail;
  out(`  ${pass}/${total} checks passed in ${Date.now() - t0}ms`);
  out(fail === 0 ? '  ALL CHECKS PASSED' : `  ${fail} FAILURE(S)`);
  return fail === 0 ? 0 : 1;
}

main().then((code) => { process.exit(code); }).catch((e: unknown) => {
  process.stderr.write(`verifier crashed: ${String(e)}\n`);
  process.exit(1);
});
