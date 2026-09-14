import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { withTenant, tenantCtx } from '../../src/db/client.js';
import { account } from '../../src/db/schema/index.js';
import { ROLES } from '../../src/db/rls.js';
import type { Harness } from './harness.js';

/**
 * Drizzle wraps driver errors, so the Postgres message (the RLS violation, the
 * trigger's RAISE) lives on .cause rather than .message. Assertions must search
 * the whole chain or they pass/fail on the wrapper text instead of the real reason.
 */
function errorText(e: unknown): string {
  const parts: string[] = [];
  let cur = e as { message?: unknown; cause?: unknown; detail?: unknown } | undefined;
  for (let depth = 0; cur && depth < 8; depth += 1) {
    if (typeof cur.message === 'string') parts.push(cur.message);
    if (typeof cur.detail === 'string') parts.push(cur.detail);
    cur = cur.cause as typeof cur;
  }
  return parts.join(' | ');
}

async function expectRejection(promise: Promise<unknown>, pattern: RegExp, what: string): Promise<void> {
  try {
    await promise;
  } catch (e) {
    const text = errorText(e);
    assert.match(text, pattern, `${what}: rejected, but not for the expected reason. Got: ${text.slice(0, 300)}`);
    return;
  }
  assert.fail(`${what}: expected a rejection but the operation succeeded`);
}

export interface Check {
  readonly group: string;
  readonly name: string;
  run(h: Harness): void | Promise<void>;
}

/**
 * Runner-agnostic assertions for Row-Level Security.
 *
 * Written once and executed two ways:
 *   - tests/integration/rls.test.ts   -> vitest, the shipped CI runner
 *   - scripts/verify-integration.ts   -> plain node, for environments too small
 *                                        to host vitest AND a WASM Postgres
 *
 * Using node:assert rather than vitest's expect is deliberate: it keeps these
 * checks independent of any test framework, so the same assertions prove the same
 * thing in both paths and cannot drift between them.
 *
 * THE POINT OF THIS FILE (PRODUCT-PLAN.md §4.2):
 * FORCE ROW LEVEL SECURITY does not apply to superusers, and PGlite connects as
 * `postgres` (superuser, BYPASSRLS=true). A suite that asserts isolation while
 * connected as the superuser reports RLS as broken, and the predictable wrong
 * response is to delete the policy. So the negative-control group below asserts
 * that the superuser DOES see everything. If that group ever fails, the role
 * wiring has regressed and every isolation assertion above it is meaningless.
 */
export const rlsChecks: readonly Check[] = [
  {
    group: 'migration + RLS installation',
    name: 'creates every table in the schema',
    run(h) { assert.ok(h.tables >= 22, `expected >=22 tables, got ${h.tables}`); },
  },
  {
    group: 'migration + RLS installation',
    name: 'enables AND forces RLS on every tenant-scoped table',
    run(h) {
      assert.ok(h.securedTables.length >= 20, `only ${h.securedTables.length} tables secured`);
      for (const t of ['account', 'audit_log', 'capture', 'deliverable', 'fact', 'person', 'site']) {
        assert.ok(h.securedTables.includes(t), `${t} is not RLS-secured`);
      }
    },
  },
  {
    group: 'migration + RLS installation',
    name: 'does not treat the tenant table itself as tenant-scoped',
    run(h) { assert.ok(!h.securedTables.includes('tenant')); },
  },
  {
    group: 'migration + RLS installation',
    name: 'application role is non-superuser without BYPASSRLS',
    async run(h) {
      const r = await h.raw.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = '${ROLES.app}'`);
      const role = r.rows[0];
      assert.ok(role, 'coldpath_app role was not created');
      assert.equal(role.rolsuper, false, 'app role must not be superuser');
      assert.equal(role.rolbypassrls, false, 'app role must not bypass RLS');
    },
  },
  {
    group: 'migration + RLS installation',
    name: 'one tenant_isolation policy per secured table',
    async run(h) {
      const r = await h.raw.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM pg_policies WHERE policyname = 'tenant_isolation'`);
      assert.equal(r.rows[0]?.c, h.securedTables.length);
    },
  },

  {
    group: 'tenant isolation as the application role',
    name: 'tenant A sees only its own accounts',
    async run(h) {
      const rows = await withTenant(h.db, tenantCtx(h.tenantAId), (tx) =>
        tx.select({ name: account.canonicalName }).from(account));
      assert.deepEqual(rows.map((r) => r.name).sort(), ['Americold Realty Trust', 'Sysco Corporation']);
    },
  },
  {
    group: 'tenant isolation as the application role',
    name: 'tenant B sees only its own accounts',
    async run(h) {
      const rows = await withTenant(h.db, tenantCtx(h.tenantBId), (tx) =>
        tx.select({ name: account.canonicalName }).from(account));
      assert.deepEqual(rows.map((r) => r.name), ['Tenant B Secret Customer']);
    },
  },
  {
    group: 'tenant isolation as the application role',
    name: "a cross-tenant WHERE clause returns nothing rather than another tenant's rows",
    async run(h) {
      const rows = await withTenant(h.db, tenantCtx(h.tenantAId), (tx) =>
        tx.select({ name: account.canonicalName }).from(account)
          .where(sql`${account.tenantId} = ${h.tenantBId}`));
      assert.deepEqual(rows, [], 'RLS must fail closed on a cross-tenant filter');
    },
  },
  {
    group: 'tenant isolation as the application role',
    name: 'sees nothing at all when app.tenant_id is unset',
    async run(h) {
      // Fail closed either way is acceptable: zero rows, or a hard error. What is
      // NOT acceptable is rows from another tenant. Assert that precisely.
      try {
        const rows = await h.db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE ${sql.raw(ROLES.app)}`);
          return tx.select({ name: account.canonicalName }).from(account);
        });
        assert.deepEqual(rows, [], 'a request with no tenant context must see nothing');
      } catch (e) {
        const text = errorText(e);
        assert.ok(!/Tenant B|Secret Customer/.test(text), `context-less query leaked data: ${text}`);
        assert.match(text, /invalid input|uuid|null value|row-level|permission/i,
          `context-less query failed for an unexpected reason: ${text.slice(0, 300)}`);
      }
    },
  },
  {
    group: 'tenant isolation as the application role',
    name: 'refuses to INSERT a row belonging to another tenant (WITH CHECK)',
    async run(h) {
      await expectRejection(
        withTenant(h.db, tenantCtx(h.tenantAId), (tx) =>
          tx.insert(account).values({ tenantId: h.tenantBId, canonicalName: 'smuggled row' })),
        /row-level security|violates row-level/i,
        'cross-tenant INSERT');
    },
  },
  {
    group: 'tenant isolation as the application role',
    name: 'a customer flag in tenant B is invisible to tenant A',
    async run(h) {
      const rows = await withTenant(h.db, tenantCtx(h.tenantAId), (tx) =>
        tx.select({ n: account.canonicalName }).from(account).where(sql`${account.isCustomer} = true`));
      assert.deepEqual(rows.map((r) => r.n), ['Americold Realty Trust']);
      assert.ok(!rows.some((r) => r.n.includes('Tenant B')), 'cross-tenant customer data leaked');
    },
  },

  {
    group: 'NEGATIVE CONTROL — proves the test would catch a misconfigured role',
    name: 'the superuser sees EVERY tenant (isolation is role-dependent, not luck)',
    async run(h) {
      const rows = await h.db.select({ name: account.canonicalName }).from(account);
      assert.equal(rows.length, 3, 'superuser should bypass RLS and see all three rows');
      assert.ok(rows.some((r) => r.name === 'Tenant B Secret Customer'));
    },
  },
  {
    group: 'NEGATIVE CONTROL — proves the test would catch a misconfigured role',
    name: 'the connection really is a superuser with BYPASSRLS',
    async run(h) {
      const r = await h.raw.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
      const me = r.rows[0];
      assert.ok(me, 'could not read current_user');
      assert.equal(me.rolsuper, true);
      assert.equal(me.rolbypassrls, true);
    },
  },
  {
    group: 'NEGATIVE CONTROL — proves the test would catch a misconfigured role',
    name: 'withTenant strictly narrows what is visible',
    async run(h) {
      const asSuper = await h.db.select().from(account);
      const asApp = await withTenant(h.db, tenantCtx(h.tenantAId), (tx) => tx.select().from(account));
      assert.ok(asSuper.length > asApp.length,
        `expected ${asSuper.length} > ${asApp.length}; if equal, the role switch is not happening`);
    },
  },

  {
    group: 'audit_log is append-only',
    name: 'rejects UPDATE',
    async run(h) {
      await h.db.execute(sql`INSERT INTO audit_log (id, tenant_id, action, resource_type, outcome)
        VALUES (gen_random_uuid(), ${h.tenantAId}, 'auth.login', 'session', 'allow')`);
      await expectRejection(h.db.execute(sql`UPDATE audit_log SET outcome = 'deny'`),
        /append-only/i, 'audit_log UPDATE');
    },
  },
  {
    group: 'audit_log is append-only',
    name: 'rejects DELETE',
    async run(h) {
      await expectRejection(h.db.execute(sql`DELETE FROM audit_log`),
        /append-only/i, 'audit_log DELETE');
    },
  },
  {
    group: 'audit_log is append-only',
    name: 'still accepts INSERT',
    async run(h) {
      await h.db.execute(sql`INSERT INTO audit_log (id, tenant_id, action, resource_type, outcome)
        VALUES (gen_random_uuid(), ${h.tenantAId}, 'pii.read', 'person', 'allow')`);
    },
  },

  {
    group: 'withTenant input validation',
    name: 'refuses a malformed tenant id',
    run() {
      assert.throws(() => tenantCtx('not-a-uuid'), /invalid tenant id/);
    },
  },
  {
    group: 'withTenant input validation',
    name: 'refuses a tenant id carrying SQL',
    run() {
      assert.throws(() => tenantCtx('11111111-1111-1111-1111-111111111111; DROP TABLE account'));
    },
  },
];
