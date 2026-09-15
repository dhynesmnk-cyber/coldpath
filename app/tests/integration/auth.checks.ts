import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { tenantCtx, withTenant } from '../../src/db/client.js';
import { account, appUser, auditLog, capture, piiGrant, roleGrant, session } from '../../src/db/schema/index.js';
import { CSRF_COOKIE, CSRF_HEADER, randomOpaqueToken, SESSION_COOKIE } from '../../src/lib/auth/cookies.js';
import { authorizeRequest, type InboundRequest } from '../../src/lib/auth/middleware.js';
import { ROLES } from '../../src/lib/auth/types.js';
import type { IdpProfile, Principal, Role } from '../../src/lib/auth/types.js';
import { AuthError } from '../../src/lib/auth/types.js';
import { canAccessPii, canUseForOutbound } from '../../src/lib/auth/permissions.js';
import { serialise, visibleFields } from '../../src/lib/auth/tiers.js';
import { createSession, pruneExpiredSessions, resolveSession, revokeSession, rotateRefresh, sessionCookies } from '../../src/lib/auth/session.js';
import { auditPiiRead } from '../../src/services/audit.js';
import { createCapture, type CaptureInput } from '../../src/services/capture.js';
import {
  deriveInitials, hasActivePiiGrant, mapGroupsToRoles, offboardUser,
  orphanedAccounts, signIn, syncGroupRoles, type GroupRoleMap,
} from '../../src/services/identity.js';
import { TENANT_A } from './harness.js';
import type { Check } from './rls.checks.js';

/**
 * AUTH-SPEC.md §12 — the acceptance tests, runner-agnostic.
 *
 * Executed two ways, from the same assertions:
 *   - tests/integration/auth.test.ts  → vitest (CI, dev machines)
 *   - scripts/verify-integration.ts   → plain node (constrained environments)
 *
 * Item #10 (unparseable/expired/wrong-audience tokens denied) lives in
 * oidc.test.ts against the mock IdP — it needs no database, so it runs
 * everywhere vitest does.
 *
 * Honesty about scope: items #1 and #13 have a UI half ("modified router
 * state", "visible on the Command dashboard") that cannot be exercised until
 * the Phase-2 HTTP adapter and front end exist. What IS proven here is the
 * half that must hold regardless of client: the SERVER refuses with 403 (not a
 * redirect, not an empty payload), and the unassigned queue is computed
 * correctly. The UI halves are tracked in BACKLOG.md and re-tested at M2.
 *
 * Checks run in order and share one harness; later checks depend on users and
 * rows created by earlier ones, exactly as the vitest file did.
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
    assert.match(errorText(e), pattern, `${what}: rejected, but not for the expected reason`);
    return;
  }
  assert.fail(`${what}: expected a rejection but the operation succeeded`);
}

const GROUP_MAP: GroupRoleMap = {
  'COLDPATH-Admins': 'admin',
  'COLDPATH-Marketing': 'marketing',
  'COLDPATH-Leads': 'sales_lead',
  'COLDPATH-Reps': 'rep',
};

function profile(sub: string, email: string, name: string, groups: string[]): IdpProfile {
  return { subject: sub, email, name, groups, claims: { sub, email, name, groups } };
}

const MADELINE = (): IdpProfile => profile('entra-0001', 'm.belvin@ndustrial.test', 'Madeline Belvin', ['COLDPATH-Marketing']);
const ADMIN = (): IdpProfile => profile('entra-0002', 'a.chen@ndustrial.test', 'Ada Chen', ['COLDPATH-Admins']);
// One email per subject: uq_app_user_email is per (tenant, email), and each
// test provisions distinct users. Plus-addressing keeps them recognizably Ruth.
const REP_EMAIL = (sub: string): string => `r.okafor+${sub}@ndustrial.test`;
const REP = (sub = 'entra-0003', groups = ['COLDPATH-Reps']): IdpProfile =>
  profile(sub, REP_EMAIL(sub), 'Ruth Okafor', groups);

function req(
  method: string,
  path: string,
  opts: { sessionToken?: string; csrf?: boolean } = {},
): InboundRequest {
  const headers: Record<string, string> = { 'user-agent': 'acceptance-verifier' };
  const cookies: string[] = [];
  if (opts.sessionToken) cookies.push(`${SESSION_COOKIE}=${opts.sessionToken}`);
  if (opts.csrf === true) {
    const token = randomOpaqueToken(24);
    cookies.push(`${CSRF_COOKIE}=${token}`);
    headers[CSRF_HEADER] = token;
  }
  if (cookies.length > 0) headers.cookie = cookies.join('; ');
  return { method, path, headers, ip: '203.0.113.7' };
}

async function expectAuthError(
  run: () => Promise<unknown>,
  code: AuthError['code'],
  status: 401 | 403,
  what: string,
): Promise<AuthError> {
  let err: unknown = null;
  try {
    await run();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof AuthError, `${what}: expected AuthError, got ${err === null ? 'success' : errorText(err)}`);
  assert.equal(err.code, code, `${what}: wrong error code`);
  assert.equal(err.status, status, `${what}: wrong HTTP status`);
  return err;
}

function principalOf(roles: Role[], over: Partial<Principal> = {}): Principal {
  return {
    userId: randomUUID(), tenantId: TENANT_A, email: 'probe@ndustrial.test',
    displayName: 'Probe', initials: null, roles, isActive: true, sessionId: 'probe-session',
    ...over,
  };
}

const PERSON_ROW = {
  name: 'Dana Whitfield', title: 'VP Operations', roleInDeal: 'champion',
  confidence: 3, isGap: false, email: 'dana@americold.example', phone: '+1-555-0100',
  linkedinUrl: 'https://linkedin.example/in/dana',
};

// Resolved by the first check; the harness seeds these names.
let syscoId = '';
let americoldId = '';
// Set by the pii.read audit check, re-read by the append-only check. Scoped by
// resource id because the RLS suite (which shares the harness in the plain-node
// verifier) also inserts pii.read rows with NULL resource ids.
let piiAuditPersonId = '';

export const authChecks: Check[] = [
  {
    group: 'harness lookup',
    name: 'locates the seeded accounts',
    async run(h) {
      const rows = await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        tx.select({ id: account.id, name: account.canonicalName }).from(account));
      syscoId = rows.find((r) => r.name === 'Sysco Corporation')?.id ?? '';
      americoldId = rows.find((r) => r.name === 'Americold Realty Trust')?.id ?? '';
      assert.notEqual(syscoId, '');
      assert.notEqual(americoldId, '');
    },
  },

  {
    group: 'sign-in lifecycle (spec §5, §8)',
    name: 'provisions from claims, maps groups to roles, never invents a default',
    async run(h) {
      const first = await signIn(h.db, { tenantId: TENANT_A, profile: MADELINE(), groupRoleMap: GROUP_MAP, ip: '203.0.113.7' });
      assert.equal(first.created, true);
      assert.deepEqual(first.roles, ['marketing']);
      assert.equal(first.user.email, 'm.belvin@ndustrial.test');
      assert.equal(first.user.initials, 'MB');

      // Second sign-in: same subject → same user, no duplicate.
      const second = await signIn(h.db, { tenantId: TENANT_A, profile: MADELINE(), groupRoleMap: GROUP_MAP });
      assert.equal(second.created, false);
      assert.equal(second.user.id, first.user.id);

      // An unmapped group grants NOTHING — not viewer, not rep, nothing.
      await expectAuthError(
        () => signIn(h.db, { tenantId: TENANT_A, profile: profile('entra-9999', 'ghost@ndustrial.test', 'Ghost', ['SOME-OTHER-GROUP']), groupRoleMap: GROUP_MAP }),
        'forbidden', 403, 'unmapped-group sign-in',
      );

      assert.equal(deriveInitials('Madeline Belvin'), 'MB');
      assert.equal(deriveInitials(null), null);
      assert.deepEqual(mapGroupsToRoles(['COLDPATH-Reps', 'NOPE'], GROUP_MAP), ['rep']);
    },
  },

  {
    group: 'acceptance #1 — rep cannot reach marketing screens',
    name: 'refuses page routes, API routes, unsafe methods and unknown routes with 403 — never a redirect',
    async run(h) {
      const rep = await signIn(h.db, { tenantId: TENANT_A, profile: REP('entra-1001'), groupRoleMap: GROUP_MAP });
      const tok = rep.session.sessionToken;
      const deploy = { tenantId: TENANT_A };

      // Direct URL to a marketing page.
      await expectAuthError(() => authorizeRequest(h.db, req('GET', '/command', { sessionToken: tok }), deploy), 'forbidden', 403, 'GET /command as rep');
      // The marketing API itself.
      await expectAuthError(() => authorizeRequest(h.db, req('GET', '/api/audit', { sessionToken: tok }), deploy), 'forbidden', 403, 'GET /api/audit as rep');
      // A `fetch` from the console: unsafe method, valid CSRF — still refused on role.
      await expectAuthError(() => authorizeRequest(h.db, req('POST', '/api/ingest/epa-rmp', { sessionToken: tok, csrf: true }), deploy), 'forbidden', 403, 'POST /api/ingest as rep');
      await expectAuthError(() => authorizeRequest(h.db, req('POST', '/api/deliverables/x/publish', { sessionToken: tok, csrf: true }), deploy), 'forbidden', 403, 'POST publish as rep');
      // "Modified router state": a route that does not exist is refused, not 404'd.
      await expectAuthError(() => authorizeRequest(h.db, req('GET', '/api/admin/everything', { sessionToken: tok }), deploy), 'forbidden', 403, 'unknown route');

      // The refusals were audited against the rep's identity.
      const [denials] = await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        tx.select({ c: sql<number>`count(*)::int` }).from(auditLog)
          .where(and(eq(auditLog.action, 'auth.denied'), eq(auditLog.userId, rep.user.id))));
      assert.ok((denials?.c ?? 0) >= 5, `expected >=5 audited denials, got ${denials?.c ?? 0}`);

      // Sanity: marketing passes the same gate; anonymous gets 401 — not 403,
      // not a redirect — because the distinction is what a client router keys on.
      const mkt = await signIn(h.db, { tenantId: TENANT_A, profile: MADELINE(), groupRoleMap: GROUP_MAP });
      const ctx = await authorizeRequest(h.db, req('GET', '/command', { sessionToken: mkt.session.sessionToken }), deploy);
      assert.ok(ctx.principal?.roles.includes('marketing'));
      await expectAuthError(() => authorizeRequest(h.db, req('GET', '/command'), deploy), 'unauthenticated', 401, 'anonymous /command');
    },
  },
  {
    group: 'acceptance #1 — rep cannot reach marketing screens',
    name: 'refuses unsafe methods without a valid CSRF double-submit',
    async run(h) {
      const mkt = await signIn(h.db, { tenantId: TENANT_A, profile: MADELINE(), groupRoleMap: GROUP_MAP });
      const deploy = { tenantId: TENANT_A };

      // No CSRF cookie/header at all — even for a principal that HAS the permission.
      await expectAuthError(
        () => authorizeRequest(h.db, req('POST', '/api/captures', { sessionToken: mkt.session.sessionToken }), deploy),
        'forbidden', 403, 'POST without CSRF',
      );

      // Mismatched cookie/header pair.
      const base = req('POST', '/api/captures', { sessionToken: mkt.session.sessionToken });
      const mismatched: InboundRequest = {
        ...base,
        headers: {
          ...base.headers,
          cookie: `${base.headers.cookie ?? ''}; ${CSRF_COOKIE}=${randomOpaqueToken(24)}`,
          [CSRF_HEADER]: randomOpaqueToken(24),
        },
      };
      await expectAuthError(() => authorizeRequest(h.db, mismatched, deploy), 'forbidden', 403, 'POST with mismatched CSRF');
    },
  },

  {
    group: 'acceptance #2 — rep cannot read unowned PII',
    name: 'gates T3 by ownership for rep/sales_lead, globally for marketing/admin',
    run() {
      const rep = principalOf(['rep']);
      const lead = principalOf(['sales_lead']);
      const mkt = principalOf(['marketing']);
      const admin = principalOf(['admin']);
      const viewer = principalOf(['viewer']);

      // Non-owner: email/phone absent even when the account id is supplied.
      const denied = serialise(PERSON_ROW, { entity: 'person', ctx: { isOwner: false, consentBasisPresent: true, confidence: 3 } }, rep);
      assert.equal('email' in denied, false);

      // Owner: visible, and the read is reportable via the hook.
      const reads: string[] = [];
      const allowed = serialise(PERSON_ROW, { entity: 'person', ctx: { isOwner: true, consentBasisPresent: true, confidence: 3 }, onPiiRead: (f) => reads.push(f) }, rep);
      assert.equal(allowed.email, PERSON_ROW.email);
      assert.deepEqual(reads.sort(), ['email', 'phone']);

      // marketing/admin: global T3 (they run the correction desk).
      assert.equal(serialise(PERSON_ROW, { entity: 'person', ctx: { isOwner: false } }, mkt).email, PERSON_ROW.email);
      assert.equal(serialise(PERSON_ROW, { entity: 'person', ctx: { isOwner: false } }, admin).email, PERSON_ROW.email);
      // sales_lead non-owner: denied, same as rep.
      assert.equal('email' in serialise(PERSON_ROW, { entity: 'person', ctx: { isOwner: false } }, lead), false);
      // viewer: no PII ever, owned or not. Neither is the unauthenticated.
      assert.equal('email' in serialise(PERSON_ROW, { entity: 'person', ctx: { isOwner: true } }, viewer), false);
      assert.equal('email' in serialise(PERSON_ROW, { entity: 'person', ctx: { isOwner: true } }, null), false);

      // Reading vs. USING for outbound are different acts (gate S5 + L8).
      assert.equal(canAccessPii(['rep'], { isOwner: true, consentBasisPresent: false }), true);
      assert.equal(canUseForOutbound(['rep'], { isOwner: true, consentBasisPresent: false, confidence: 3 }), false);
      assert.equal(canUseForOutbound(['rep'], { isOwner: true, consentBasisPresent: true, confidence: 2 }), false);
      assert.equal(canUseForOutbound(['rep'], { isOwner: true, consentBasisPresent: true, confidence: 3 }), true);
      assert.equal(canUseForOutbound(['rep'], { isOwner: false, consentBasisPresent: true, confidence: 3 }), false);
    },
  },

  {
    group: 'AUTH-SPEC §7 — every role\'s field set, pinned',
    name: 'viewer receives T0 only; T1/T2 start at rep',
    run() {
      // This check exists because its absence let a real regression ship. Tier
      // assertions were per-field ("can a viewer read email?"), and a viewer
      // failing the PII check looked like the tier model working. It was not:
      // maxTierFor() fell through to library.read — granted to EVERY role — so a
      // viewer received the identical field set to a rep, including icpScore,
      // researchState and published deliverable bodies. Asserting one field at a
      // time cannot catch that. Asserting the WHOLE set can.
      const account = (r: Role[]): string[] => visibleFields('account', principalOf(r)).sort();

      // T0 is public registry data — what anyone could pull from EPA themselves.
      const T0_ACCOUNT = ['hq', 'ticker', 'website'];
      assert.deepEqual(account(['viewer']), T0_ACCOUNT, 'viewer must see T0 and nothing else');

      // rep and above add T1/T2. The exact set, not a spot check.
      const REP_ACCOUNT = [
        'canonicalName', 'crmId', 'hq', 'icpComponents', 'icpScore', 'ownerId', 'priority',
        'refreshDueAt', 'repId', 'researchState', 'researchedAt', 'status', 'ticker',
        'vertical', 'website',
      ];
      assert.deepEqual(account(['rep']), REP_ACCOUNT);
      assert.deepEqual(account(['sales_lead']), REP_ACCOUNT);

      // T4 (isCustomer) is marketing/admin only — the suppression flag, never content.
      assert.deepEqual(account(['marketing']), [...REP_ACCOUNT, 'isCustomer'].sort());
      assert.deepEqual(account(['admin']), [...REP_ACCOUNT, 'isCustomer'].sort());

      // A viewer must not reach T1 analysis or T2 research through any entity.
      for (const entity of ['account', 'person', 'deliverable', 'signal'] as const) {
        const seen = visibleFields(entity, principalOf(['viewer']));
        assert.equal(seen.includes('icpScore'), false, `viewer saw icpScore on ${entity}`);
        assert.equal(seen.includes('body'), false, `viewer saw a deliverable body on ${entity}`);
        assert.equal(seen.includes('email'), false, `viewer saw PII on ${entity}`);
      }

      // Unauthenticated and deactivated principals receive nothing at all.
      assert.deepEqual(visibleFields('account', null), []);
      assert.deepEqual(
        visibleFields('account', { ...principalOf(['admin']), isActive: false }), [],
        'a deactivated admin must serialise to nothing',
      );
    },
  },

  {
    group: 'acceptance #3 — attribution cannot be forged',
    name: 'writes captured_by from the session and ignores any smuggled value',
    async run(h) {
      const rep = await signIn(h.db, { tenantId: TENANT_A, profile: REP('entra-3001'), groupRoleMap: GROUP_MAP });
      const mkt = await signIn(h.db, { tenantId: TENANT_A, profile: MADELINE(), groupRoleMap: GROUP_MAP });
      const ctx = {
        principal: { ...principalOf(['rep'], { userId: rep.user.id, email: rep.user.email, displayName: rep.user.displayName }), roles: rep.roles },
        tenantId: TENANT_A, ip: '203.0.113.9', userAgent: 'acceptance',
      };

      // A JavaScript caller smuggles capturedBy past the type system. The
      // service reads only whitelisted keys, so the forgery attempt is inert.
      const smuggled = {
        rawText: 'Dana Whitfield — VP Operations, saw her talk at REX 2026',
        expiresAt: new Date(Date.now() + 90 * 86_400_000),
        accountId: syscoId,
        capturedBy: mkt.user.id, // ← the forgery
      } as unknown as CaptureInput;

      const { id } = await withTenant(h.db, tenantCtx(TENANT_A), (tx) => createCapture(tx, ctx, smuggled));
      const rows = await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        tx.select().from(capture).where(eq(capture.id, id)));
      assert.equal(rows.length, 1);
      const row = rows.at(0);
      assert.ok(row !== undefined);
      assert.equal(row.capturedBy, rep.user.id);
      assert.notEqual(row.capturedBy, mkt.user.id);

      // A viewer cannot create captures at all.
      const viewerCtx = { ...ctx, principal: { ...ctx.principal, roles: ['viewer'] as Role[] } };
      await expectAuthError(
        () => withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
          createCapture(tx, viewerCtx, { rawText: 'x', expiresAt: new Date(Date.now() + 86_400_000) })),
        'forbidden', 403, 'viewer capture',
      );
    },
  },

  {
    group: 'acceptance #4 — T4 never in exports',
    name: 'omits isCustomer from exports for every role including admin; keeps it for on-screen suppression',
    run() {
      const row = { canonicalName: 'Americold Realty Trust', isCustomer: true, vertical: 'cold_storage_logistics', status: 'published' };
      for (const role of ROLES) {
        const out = serialise(row, { entity: 'account', forExport: true }, principalOf([role]));
        assert.equal('isCustomer' in out, false, `T4 leaked into export for role ${role}`);
      }
      // Unauthenticated: nothing at all.
      assert.deepEqual(Object.keys(serialise(row, { entity: 'account', forExport: true }, null)), []);

      // On internal screens (not exports) marketing/admin DO see the flag —
      // that is what gate C5 suppresses rows with — and below them nobody does.
      assert.equal(serialise(row, { entity: 'account' }, principalOf(['marketing'])).isCustomer, true);
      assert.equal('isCustomer' in serialise(row, { entity: 'account' }, principalOf(['rep'])), false);
      assert.equal('isCustomer' in serialise(row, { entity: 'account' }, principalOf(['sales_lead'])), false);
    },
  },

  {
    group: 'acceptance #5 — revoked session refused on next request',
    name: 'revocation is immediate, not at token expiry',
    async run(h) {
      const user = await signIn(h.db, { tenantId: TENANT_A, profile: ADMIN(), groupRoleMap: GROUP_MAP });
      const tok = user.session.sessionToken;
      const deploy = { tenantId: TENANT_A };

      const before = await authorizeRequest(h.db, req('GET', '/api/me', { sessionToken: tok }), deploy);
      assert.equal(before.principal?.userId, user.user.id);

      await withTenant(h.db, tenantCtx(TENANT_A), (tx) => revokeSession(tx, user.session.sessionId, 'admin action'));

      await expectAuthError(() => authorizeRequest(h.db, req('GET', '/api/me', { sessionToken: tok }), deploy), 'unauthenticated', 401, 'revoked session');
      assert.equal(await withTenant(h.db, tenantCtx(TENANT_A), (tx) => resolveSession(tx, tok)), null);
    },
  },

  {
    group: 'acceptance #6 — refresh reuse revokes the family',
    name: 'rotates single-use and burns the whole family on replay',
    async run(h) {
      const user = await signIn(h.db, { tenantId: TENANT_A, profile: REP('entra-6001'), groupRoleMap: GROUP_MAP });
      const original = user.session;

      const first = await withTenant(h.db, tenantCtx(TENANT_A), (tx) => rotateRefresh(tx, original.refreshToken));
      assert.ok(first.ok, 'first rotation must succeed'); // also narrows for tsc

      // Replay the consumed token — the theft signal.
      const replay = await withTenant(h.db, tenantCtx(TENANT_A), (tx) => rotateRefresh(tx, original.refreshToken));
      assert.deepEqual(replay, { ok: false, reason: 'reused' });

      // The legitimate new token is dead too: the family was revoked.
      assert.equal(
        await withTenant(h.db, tenantCtx(TENANT_A), (tx) => resolveSession(tx, first.issued.sessionToken)),
        null,
      );
      const srows = await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        tx.select().from(session).where(eq(session.id, original.sessionId)));
      assert.notEqual(srows[0]?.revokedAt, null);
      assert.match(srows[0]?.revokeReason ?? '', /reuse/i);
    },
  },

  {
    group: 'acceptance #6 — refresh reuse revokes the family',
    name: 'concurrent replays of one token cannot both mint a session',
    async run(h) {
      const user = await signIn(h.db, { tenantId: TENANT_A, profile: REP('entra-6002'), groupRoleMap: GROUP_MAP });

      // Fire the SAME refresh token twice with no ordering between them. The
      // previous implementation read the row, checked refresh_rotated_at, then
      // updated: under READ COMMITTED both callers saw NULL, both passed the
      // reuse check and both rotated. The tripwire never fired in exactly the
      // case it exists for. Consuming via a conditional UPDATE means the row
      // itself arbitrates and precisely one caller can win.
      const [a, b] = await Promise.all([
        withTenant(h.db, tenantCtx(TENANT_A), (tx) => rotateRefresh(tx, user.session.refreshToken)),
        withTenant(h.db, tenantCtx(TENANT_A), (tx) => rotateRefresh(tx, user.session.refreshToken)),
      ]);

      const winners = [a, b].filter((r) => r.ok);
      assert.equal(winners.length, 1, 'exactly one concurrent rotation may succeed');

      const loser = [a, b].find((r) => !r.ok);
      assert.ok(loser !== undefined && !loser.ok);
      // The loser must be refused. 'reused' means it raced and lost after the
      // winner committed; 'revoked' means it lost before. Either is a refusal —
      // what must never happen is a second `ok`.
      assert.ok(['reused', 'revoked'].includes(loser.reason), `unexpected reason ${loser.reason}`);
    },
  },

  {
    group: 'session hygiene',
    name: 'pruneExpiredSessions removes only sessions already past expiry',
    async run(h) {
      const user = await signIn(h.db, { tenantId: TENANT_A, profile: REP('entra-6003'), groupRoleMap: GROUP_MAP });
      const live = user.session.sessionToken;

      await withTenant(h.db, tenantCtx(TENANT_A), async (tx) => {
        // One row expired an hour ago, alongside the live session above.
        const stale = await createSession(tx, { userId: user.user.id, tenantId: TENANT_A });
        await tx.update(session)
          .set({ expiresAt: new Date(Date.now() - 3_600_000) })
          .where(eq(session.id, stale.sessionId));

        const removed = await pruneExpiredSessions(tx, new Date());
        assert.ok(removed >= 1, 'the expired row must be pruned');

        // The live session is untouched and still resolves.
        assert.notEqual(await resolveSession(tx, live), null, 'pruning must not touch live sessions');
      });
    },
  },

  {
    group: 'acceptance #7 — leaving the IdP group removes the role',
    name: 'revokes group-derived grants on next sign-in, immediately killing live sessions',
    async run(h) {
      const sub = 'entra-7001';
      const first = await signIn(h.db, { tenantId: TENANT_A, profile: REP(sub), groupRoleMap: GROUP_MAP });
      assert.deepEqual(first.roles, ['rep']);

      // Removed from COLDPATH-Reps in the directory. The sign-in is REFUSED
      // (zero roles) but the revocation COMMITS — two transactions, on purpose.
      await expectAuthError(
        () => signIn(h.db, { tenantId: TENANT_A, profile: REP(sub, []), groupRoleMap: GROUP_MAP }),
        'forbidden', 403, 'sign-in after group removal',
      );

      // The still-unexpired session from before is now useless: roles load per
      // request, so removal bites on the NEXT request, not at token expiry —
      // comfortably inside the "one access-session lifetime" the spec allows.
      assert.equal(
        await withTenant(h.db, tenantCtx(TENANT_A), (tx) => resolveSession(tx, first.session.sessionToken)),
        null,
      );
      const grants = await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        tx.select().from(roleGrant).where(eq(roleGrant.userId, first.user.id)));
      assert.equal(grants.length, 0);
    },
  },
  {
    group: 'acceptance #7 — leaving the IdP group removes the role',
    name: 'never touches hand-granted roles during group sync',
    async run(h) {
      const admin = await signIn(h.db, { tenantId: TENANT_A, profile: ADMIN(), groupRoleMap: GROUP_MAP });
      const sub = 'entra-7002';
      const user = await signIn(h.db, { tenantId: TENANT_A, profile: REP(sub), groupRoleMap: GROUP_MAP });

      // An admin grants sales_lead by hand (granted_by set → sync won't touch).
      await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        tx.insert(roleGrant).values({ tenantId: TENANT_A, userId: user.user.id, role: 'sales_lead', grantedBy: admin.user.id }));

      // Removed from the rep group; the hand grant must survive.
      const again = await signIn(h.db, { tenantId: TENANT_A, profile: REP(sub, []), groupRoleMap: GROUP_MAP });
      assert.deepEqual(again.roles, ['sales_lead']);

      // Sync is idempotent: re-adding the group re-grants rep, nothing doubles.
      const back = await signIn(h.db, { tenantId: TENANT_A, profile: REP(sub), groupRoleMap: GROUP_MAP });
      assert.deepEqual([...back.roles].sort(), ['rep', 'sales_lead']);
      const rows = await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        tx.select().from(roleGrant).where(eq(roleGrant.userId, user.user.id)));
      assert.equal(rows.length, 2);
    },
  },

  {
    group: 'acceptance #8 — audit records T3 reads, is append-only',
    name: 'records user, resource, field, timestamp and IP for a PII read',
    async run(h) {
      const mkt = await signIn(h.db, { tenantId: TENANT_A, profile: MADELINE(), groupRoleMap: GROUP_MAP });
      const personId = randomUUID();
      piiAuditPersonId = personId;

      const reads: string[] = [];
      serialise(PERSON_ROW, {
        entity: 'person',
        ctx: { isOwner: false, consentBasisPresent: true, confidence: 3 },
        onPiiRead: (f) => { reads.push(f); },
      }, principalOf(['marketing'], { userId: mkt.user.id }));
      assert.deepEqual(reads.sort(), ['email', 'phone']);

      for (const field of reads) {
        await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
          auditPiiRead(tx, { tenantId: TENANT_A, userId: mkt.user.id, personId, field: field, ip: '203.0.113.7' }));
      }

      const logged = await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        tx.select().from(auditLog)
          .where(and(eq(auditLog.action, 'pii.read'), eq(auditLog.resourceId, personId))));
      assert.equal(logged.length, 2);
      for (const r of logged) {
        assert.equal(r.userId, mkt.user.id);
        assert.equal(r.resourceId, personId);
        assert.equal(r.outcome, 'allow');
        assert.equal(r.ip, '203.0.113.7');
        assert.ok(r.at instanceof Date);
        assert.ok(['email', 'phone'].includes((r.meta as { field: string }).field));
      }
    },
  },
  {
    group: 'acceptance #8 — audit records T3 reads, is append-only',
    name: 'refuses UPDATE and DELETE as the application role',
    async run(h) {
      // Two independent layers stop these: the REVOKE (permission denied)
      // fires before the trigger (append-only). Either proves the point.
      // Each attempt gets its own transaction: in Postgres, a failed statement
      // aborts its transaction, and a second attempt inside it would fail with
      // "transaction is aborted" — the wrong reason, masking the right one.
      await expectRejection(
        withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
          tx.execute(sql`UPDATE audit_log SET outcome = 'deny' WHERE action = 'pii.read'`)),
        /append-only|permission denied/i, 'audit_log UPDATE as app role');
      await expectRejection(
        withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
          tx.execute(sql`DELETE FROM audit_log WHERE action = 'pii.read'`)),
        /append-only|permission denied/i, 'audit_log DELETE as app role');
      const [left] = await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        tx.select({ c: sql<number>`count(*)::int` }).from(auditLog)
          .where(and(eq(auditLog.action, 'pii.read'), eq(auditLog.resourceId, piiAuditPersonId))));
      assert.equal(left?.c, 2);
    },
  },
  {
    group: 'acceptance #8 — audit records T3 reads, is append-only',
    name: 'accepts anonymous (NULL-tenant) audit inserts as the app role',
    async run(h) {
      // Failed-auth records can predate any tenant context; the
      // audit_anonymous_insert policy must not silently drop them.
      await h.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE coldpath_app`);
        await tx.execute(sql`INSERT INTO audit_log (id, tenant_id, action, resource_type, outcome, reason)
                             VALUES (gen_random_uuid(), NULL, 'auth.denied', 'route', 'deny', 'anonymous probe')`);
      });
      const [found] = await h.db.select({ c: sql<number>`count(*)::int` }).from(auditLog)
        .where(sql`tenant_id IS NULL AND reason = 'anonymous probe'`);
      assert.equal(found?.c, 1);
    },
  },

  {
    group: 'acceptance #9 — omitted fields are absent, not null or masked',
    name: 'serialization removes the key entirely; the wire format has no trace',
    run() {
      const out = serialise(PERSON_ROW, { entity: 'person', ctx: { isOwner: false } }, principalOf(['rep'])) as Record<string, unknown>;
      assert.equal('email' in out, false);
      assert.equal('phone' in out, false);
      assert.equal(out.email, undefined);
      // No `"email":null`, no `"email":"***"` — absence, not disguise.
      const wire = JSON.stringify(out);
      assert.equal(wire.includes('email'), false);
      assert.equal(wire.includes('phone'), false);
      assert.equal(wire.includes('*'), false);
      // Fields the rep MAY see are untouched.
      assert.equal(out.name, PERSON_ROW.name);
      assert.equal(out.title, PERSON_ROW.title);
    },
  },

  {
    group: 'acceptance #11 — cookie attributes; no localStorage',
    name: 'session and refresh cookies are HttpOnly + Secure + SameSite=Lax; CSRF is the readable one',
    run() {
      const c = sessionCookies('tok'.padEnd(32, 'x'), 'ref'.padEnd(32, 'y'), true);
      assert.equal(c.set.length, 3);
      const [sessionCookie, refreshCookie, csrfCookie] = c.set as [string, string, string];
      for (const cookie of [sessionCookie, refreshCookie]) {
        assert.ok(cookie.includes('HttpOnly'), `missing HttpOnly: ${cookie}`);
        assert.ok(cookie.includes('Secure'), `missing Secure: ${cookie}`);
        assert.ok(cookie.includes('SameSite=Lax'), `missing SameSite=Lax: ${cookie}`);
        assert.ok(cookie.includes('Path=/'), `missing Path: ${cookie}`);
      }
      assert.ok(refreshCookie.includes('Path=/api/auth'));
      // The CSRF token is deliberately readable by script (double-submit) and
      // authenticates nothing on its own.
      assert.ok(csrfCookie.includes(CSRF_COOKIE));
      assert.ok(!csrfCookie.includes('HttpOnly'), 'CSRF cookie must be script-readable');
      assert.ok(csrfCookie.includes('SameSite=Lax'));
      assert.deepEqual(c.clear, []);
    },
  },
  {
    group: 'acceptance #11 — cookie attributes; no localStorage',
    name: 'no code path writes tokens to localStorage (source scan)',
    run() {
      // The server codebase must never emit client-storage writes; the SPA
      // (M2) inherits this rule and this scan grows to cover it.
      const offenders: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) { walk(full); continue; }
          if (!entry.endsWith('.ts')) continue;
          // Property access = usage; a comment ABOUT localStorage (cookies.ts
          // explains why tokens never go there) is not usage.
          if (/\b(localStorage|sessionStorage)\s*\./.test(readFileSync(full, 'utf8'))) offenders.push(full);
        }
      };
      walk('src');
      assert.deepEqual(offenders, []);
    },
  },

  {
    group: 'acceptance #12 — deactivation keeps attribution, kills authority',
    name: "deactivated user's captures stay attributed; pii_grants stop authorizing; login stays refused",
    async run(h) {
      const sub = 'entra-1201';
      const rep = await signIn(h.db, { tenantId: TENANT_A, profile: REP(sub), groupRoleMap: GROUP_MAP });
      const ctx = {
        principal: { ...principalOf(['rep'], { userId: rep.user.id }), roles: rep.roles },
        tenantId: TENANT_A, ip: '203.0.113.9', userAgent: 'acceptance',
      };

      const { id: captureId } = await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        createCapture(tx, ctx, { rawText: 'Plant tour note — Sysco dock 4', expiresAt: new Date(Date.now() + 86_400_000), accountId: syscoId }));

      const personId = randomUUID();
      await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        tx.insert(piiGrant).values({ tenantId: TENANT_A, userId: rep.user.id, personId, field: 'email', consentBasis: 'legitimate_interest_b2b' }));
      assert.equal(
        await withTenant(h.db, tenantCtx(TENANT_A), (tx) => hasActivePiiGrant(tx, { tenantId: TENANT_A, userId: rep.user.id, personId, field: 'email' })),
        true,
      );

      const off = await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        offboardUser(tx, { tenantId: TENANT_A, userId: rep.user.id, reason: 'left the company' }));
      assert.ok(off.sessionsRevoked >= 1);

      // The PII grant no longer authorizes anything.
      assert.equal(
        await withTenant(h.db, tenantCtx(TENANT_A), (tx) => hasActivePiiGrant(tx, { tenantId: TENANT_A, userId: rep.user.id, personId, field: 'email' })),
        false,
      );

      // The capture is STILL attributed — history is not rewritten.
      const capRows = await withTenant(h.db, tenantCtx(TENANT_A), (tx) => tx.select().from(capture).where(eq(capture.id, captureId)));
      assert.equal(capRows.length, 1);
      assert.equal(capRows[0]?.capturedBy, rep.user.id);
      const userRows = await withTenant(h.db, tenantCtx(TENANT_A), (tx) => tx.select().from(appUser).where(eq(appUser.id, rep.user.id)));
      assert.equal(userRows[0]?.isActive, false);

      // Live session dead on the next request; re-login refused as inactive —
      // authenticating at the IdP does NOT resurrect a local offboarding.
      assert.equal(await withTenant(h.db, tenantCtx(TENANT_A), (tx) => resolveSession(tx, rep.session.sessionToken)), null);
      await expectAuthError(
        () => signIn(h.db, { tenantId: TENANT_A, profile: REP(sub), groupRoleMap: GROUP_MAP }),
        'inactive', 401, 're-login after offboarding',
      );
    },
  },

  {
    group: 'acceptance #13 — orphaned accounts surface',
    name: 'deactivating the sole owner puts the account in the unassigned queue',
    async run(h) {
      const sub = 'entra-1301';
      const rep = await signIn(h.db, { tenantId: TENANT_A, profile: REP(sub), groupRoleMap: GROUP_MAP });

      await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        tx.update(account).set({ ownerId: rep.user.id }).where(eq(account.id, syscoId)));

      let orphans = await withTenant(h.db, tenantCtx(TENANT_A), (tx) => orphanedAccounts(tx, TENANT_A));
      assert.equal(orphans.find((o) => o.id === syscoId), undefined); // owned + active

      await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        offboardUser(tx, { tenantId: TENANT_A, userId: rep.user.id, reason: 'left the company' }));

      orphans = await withTenant(h.db, tenantCtx(TENANT_A), (tx) => orphanedAccounts(tx, TENANT_A));
      assert.equal(orphans.find((o) => o.id === syscoId)?.reason, 'owner_inactive');
      // The never-assigned account is in the same queue, for a different reason.
      assert.equal(orphans.find((o) => o.id === americoldId)?.reason, 'unowned');

      // Excluded accounts never surface, orphaned or not.
      await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        tx.update(account).set({ status: 'excluded' }).where(eq(account.id, syscoId)));
      orphans = await withTenant(h.db, tenantCtx(TENANT_A), (tx) => orphanedAccounts(tx, TENANT_A));
      assert.equal(orphans.find((o) => o.id === syscoId), undefined);
      // (UI half — "visible on the Command dashboard" — lands with M2.)
    },
  },

  {
    group: 'session internals under RLS',
    name: 'resolveSession refuses unknown, expired and role-less tokens',
    async run(h) {
      assert.equal(await withTenant(h.db, tenantCtx(TENANT_A), (tx) => resolveSession(tx, undefined)), null);
      assert.equal(await withTenant(h.db, tenantCtx(TENANT_A), (tx) => resolveSession(tx, 'not-a-real-token')), null);

      const user = await signIn(h.db, { tenantId: TENANT_A, profile: REP('entra-1401'), groupRoleMap: GROUP_MAP });
      // Force-expire the row: the token itself is still well-formed.
      await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        tx.update(session).set({ expiresAt: new Date(Date.now() - 1000) })
          .where(and(eq(session.userId, user.user.id), eq(session.id, user.session.sessionId))));
      assert.equal(await withTenant(h.db, tenantCtx(TENANT_A), (tx) => resolveSession(tx, user.session.sessionToken)), null);
    },
  },
  {
    group: 'session internals under RLS',
    name: 'syncGroupRoles is callable directly for scheduled re-syncs',
    async run(h) {
      const user = await signIn(h.db, { tenantId: TENANT_A, profile: REP('entra-1402'), groupRoleMap: GROUP_MAP });
      const res = await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        syncGroupRoles(tx, { tenantId: TENANT_A, userId: user.user.id, groups: ['COLDPATH-Leads'], map: GROUP_MAP }));
      assert.deepEqual(res.granted, ['sales_lead']);
      assert.deepEqual(res.revoked, ['rep']);
      // A no-op sync changes nothing.
      const again = await withTenant(h.db, tenantCtx(TENANT_A), (tx) =>
        syncGroupRoles(tx, { tenantId: TENANT_A, userId: user.user.id, groups: ['COLDPATH-Leads'], map: GROUP_MAP }));
      assert.deepEqual(again, { granted: [], revoked: [] });
    },
  },
];
