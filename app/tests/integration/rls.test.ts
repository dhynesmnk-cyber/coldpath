import { afterAll, beforeAll, describe, it } from 'vitest';
import { setupHarness, type Harness } from './harness.js';
import { rlsChecks } from './rls.checks.js';

/**
 * Vitest wrapper. The assertions live in rls.checks.ts and use node:assert, so
 * the identical checks also run under scripts/verify-integration.ts in
 * environments too small to host vitest and a WASM Postgres at once.
 */
let h: Harness | undefined;

beforeAll(async () => { h = await setupHarness(); }, 180_000);
afterAll(async () => { await h?.close(); });

const groups = [...new Set(rlsChecks.map((c) => c.group))];

for (const group of groups) {
  describe(group, () => {
    for (const check of rlsChecks.filter((c) => c.group === group)) {
      it(check.name, async () => {
        if (h === undefined) throw new Error('harness not initialised');
        await check.run(h);
      }, 60_000);
    }
  });
}
