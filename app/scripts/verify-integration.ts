/**
 * Plain-node integration verifier.
 *
 * Runs the exact same assertions as tests/integration/rls.test.ts and
 * tests/integration/auth.test.ts (they share rls.checks.ts / auth.checks.ts)
 * without a test framework. Two reasons this exists:
 *
 *   1. Constrained environments. Each integration test loads a WASM Postgres
 *      (~300 MB). Vitest's process model on top of that needs more headroom than
 *      a 1 GB sandbox provides. The product targets 2 GB+, where `npm test` is
 *      the normal path — this script is the fallback, not the default.
 *   2. It runs against compiled output (dist/), i.e. the artefacts that ship.
 *
 * The RLS suite runs first, then the AUTH-SPEC §12 acceptance suite, on ONE
 * shared harness: a second PGlite instance is exactly the memory this script
 * exists to avoid. The auth checks are written to tolerate the rows the RLS
 * checks leave behind (see auth.checks.ts).
 *
 * Usage:  npm run build && npm run verify:integration
 */
import { setupHarness } from '../tests/integration/harness.js';
import { rlsChecks, type Check } from '../tests/integration/rls.checks.js';
import { authChecks } from '../tests/integration/auth.checks.js';

const out = (s: string): void => { process.stdout.write(s + '\n'); };

async function main(): Promise<number> {
  const t0 = Date.now();
  out('COLDPATH integration verifier');
  out('='.repeat(58));
  const h = await setupHarness();
  out(`  harness ready in ${Date.now() - t0}ms — ${h.tables} tables, ${h.securedTables.length} RLS-secured\n`);

  let pass = 0;
  let fail = 0;

  const runSuite = async (title: string, checks: readonly Check[]): Promise<void> => {
    out(`  ── ${title} ──`);
    let group = '';
    for (const check of checks) {
      if (check.group !== group) { group = check.group; out(`  ${group}`); }
      const start = Date.now();
      try {
        await check.run(h);
        pass += 1;
        out(`    ok    ${check.name}  (${Date.now() - start}ms)`);
      } catch (e) {
        fail += 1;
        out(`    FAIL  ${check.name}`);
        out(`          ${(e as Error).message.split('\n')[0]?.slice(0, 220) ?? String(e)}`);
      }
    }
    out('');
  };

  await runSuite('RLS & tenancy', rlsChecks);
  await runSuite('AUTH-SPEC §12 acceptance', authChecks);

  await h.close();
  out(`  ${pass}/${pass + fail} checks passed in ${Date.now() - t0}ms`);
  if (fail > 0) { out(`  ${fail} FAILURE(S)`); return 1; }
  out('  ALL CHECKS PASSED');
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e: unknown) => { out(`verifier crashed: ${String(e)}`); process.exitCode = 2; });
