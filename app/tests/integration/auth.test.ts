import { afterAll, beforeAll, describe, it } from 'vitest';
import { setupHarness, type Harness } from './harness.js';
import { authChecks } from './auth.checks.js';

/**
 * Vitest wrapper for the AUTH-SPEC §12 acceptance tests. The assertions live
 * in auth.checks.ts using node:assert, so the identical checks also run under
 * scripts/verify-integration.ts in environments too small to host vitest and a
 * WASM Postgres at once. (Acceptance #10 — IdP token validation — lives in
 * oidc.test.ts; it needs no database.)
 */
let h: Harness | undefined;

beforeAll(async () => { h = await setupHarness(); }, 180_000);
afterAll(async () => { await h?.close(); });

const groups = [...new Set(authChecks.map((c) => c.group))];

for (const group of groups) {
  describe(group, () => {
    for (const check of authChecks.filter((c) => c.group === group)) {
      it(check.name, async () => {
        if (h === undefined) throw new Error('harness not initialised');
        await check.run(h);
      }, 120_000);
    }
  });
}
