import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '../../db/client.js';
import { appUser, roleGrant, session } from '../../db/schema/index.js';
import { clearCookie, CSRF_COOKIE, generateToken, randomOpaqueToken, REFRESH_COOKIE, serializeCookie, SESSION_COOKIE } from './cookies.js';
import type { Principal, Role } from './types.js';

/** AUTH-SPEC.md §8. Access session is one working day; refresh is 30 days. */
export const ACCESS_TTL_SECONDS = 8 * 60 * 60;
export const REFRESH_TTL_DAYS = 30;
export const REFRESH_TTL_SECONDS = REFRESH_TTL_DAYS * 24 * 60 * 60;

/**
 * Only the hash is stored. A database leak yields no usable session, and a
 * stolen cookie value cannot be reversed into anything meaningful.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function eqHash(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface IssuedSession {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
}

export interface SessionCookies {
  readonly set: string[];
  readonly clear: string[];
}

export function sessionCookies(token: string, refresh: string, secure = true): SessionCookies {
  return {
    set: [
      serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: ACCESS_TTL_SECONDS, secure }),
      serializeCookie(REFRESH_COOKIE, refresh, { maxAgeSeconds: REFRESH_TTL_SECONDS, secure, path: '/api/auth' }),
      // Double-submit CSRF token. Deliberately the one non-HttpOnly cookie: the
      // page script must read it to echo it in the x-coldpath-csrf header. It
      // authenticates nothing on its own, so readability is not a leak.
      serializeCookie(CSRF_COOKIE, randomOpaqueToken(24), { maxAgeSeconds: ACCESS_TTL_SECONDS, secure, httpOnly: false }),
    ],
    clear: [],
  };
}

export function clearedSessionCookies(secure = true): SessionCookies {
  return {
    set: [],
    clear: [
      clearCookie(SESSION_COOKIE, { secure }),
      clearCookie(REFRESH_COOKIE, { secure, path: '/api/auth' }),
      clearCookie(CSRF_COOKIE, { secure, httpOnly: false }),
    ],
  };
}

export async function createSession(
  db: Db | Tx,
  p: { userId: string; tenantId: string; ip?: string | null; userAgent?: string | null; idpSessionId?: string | null },
): Promise<IssuedSession> {
  const sessionToken = generateToken();
  const refreshToken = generateToken();
  const expiresAt = new Date(Date.now() + ACCESS_TTL_SECONDS * 1000);
  const [row] = await db.insert(session).values({
    userId: p.userId,
    tenantId: p.tenantId,
    tokenHash: hashToken(sessionToken),
    refreshHash: hashToken(refreshToken),
    expiresAt,
    ip: p.ip ?? null,
    userAgent: p.userAgent ?? null,
    idpSessionId: p.idpSessionId ?? null,
  }).returning({ id: session.id });
  if (!row) throw new Error('session insert returned no row');
  return { sessionId: row.id, sessionToken, refreshToken, expiresAt };
}

/**
 * Roles currently in force for a user: granted, and not past their expiry.
 *
 * Lives here rather than in services/identity.ts because both the session layer
 * and the identity service need it, and lib must not import from services. It
 * existed in both files as byte-identical copies; two copies of an authorization
 * predicate is one more than can be kept correct.
 */
export async function activeRoles(db: Db | Tx, tenantId: string, userId: string): Promise<Role[]> {
  const rows = await db.select({ role: roleGrant.role, expiresAt: roleGrant.expiresAt })
    .from(roleGrant)
    .where(and(eq(roleGrant.userId, userId), eq(roleGrant.tenantId, tenantId)));
  const now = new Date();
  return rows
    .filter((r) => r.expiresAt === null || r.expiresAt > now)
    .map((r) => r.role);
}

export interface ResolvedSession {
  readonly principal: Principal;
  readonly expiresAt: Date;
}

/**
 * Validate a session token and build the Principal.
 *
 * Fails closed on every branch: unknown token, revoked session, expired session,
 * deactivated user, or a user with no roles. None of these produce a permissive
 * default (AUTH-SPEC.md §3, principle 7).
 */
export async function resolveSession(db: Db | Tx, token: string | undefined): Promise<ResolvedSession | null> {
  if (token === undefined || token.length === 0) return null;
  const hash = hashToken(token);
  // Indexed equality on the unique token_hash column.
  //
  // This used to SELECT every row and scan them in JavaScript with a
  // constant-time compare, so that timing would not leak how many sessions
  // exist. That protected nothing and cost a great deal. The stored value is a
  // SHA-256 of 32 random bytes: an attacker cannot craft a token whose hash is
  // close to a real one, so per-row timing carries no signal to extract. What it
  // did cost was every authenticated request reading the whole table — measured
  // at 3.3 ms with one row and 130 ms at 7,500 — and rows are only ever revoked,
  // never deleted, so the cost grew monotonically and forever.
  //
  // eqHash stays for the single fetched row: cheap, and it keeps the comparison
  // constant-time where a `===` would not be.
  const [row] = await db.select().from(session).where(eq(session.tokenHash, hash)).limit(1);
  if (row === undefined) return null;
  if (!eqHash(row.tokenHash, hash)) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt <= new Date()) return null;

  const [user] = await db.select().from(appUser).where(eq(appUser.id, row.userId));
  if (user?.isActive !== true) return null;

  const roles = await activeRoles(db, row.tenantId, row.userId);
  if (roles.length === 0) return null;      // no roles = no access, not viewer-by-default

  await db.update(session).set({ lastSeenAt: new Date() }).where(eq(session.id, row.id));
  return {
    principal: {
      userId: user.id, tenantId: row.tenantId, email: user.email,
      displayName: user.displayName, initials: user.initials,
      roles, isActive: user.isActive, sessionId: row.id,
    },
    expiresAt: row.expiresAt,
  };
}

/**
 * Rotate a refresh token — the family model.
 *
 * Rotation INSERTS a new session row in the same family; the consumed row is
 * revoked but KEEPS its refresh hash. That retained hash is the tripwire: a
 * token presented twice still matches its (rotated) row, which is how reuse is
 * distinguished from an unknown token. On reuse the whole family is revoked —
 * the legitimate user re-authenticates, the thief loses access (AUTH-SPEC §8).
 *
 * Overwriting the hash in place (the previous shape of this function) made
 * replays indistinguishable from garbage: `unknown` instead of `reused`, and
 * no family revocation. The acceptance test caught it; this comment exists so
 * nobody "simplifies" it back.
 */
export async function rotateRefresh(
  db: Db | Tx,
  refreshToken: string | undefined,
): Promise<{ ok: true; issued: IssuedSession } | { ok: false; reason: 'unknown' | 'reused' | 'revoked' | 'expired' }> {
  if (refreshToken === undefined || refreshToken.length === 0) return { ok: false, reason: 'unknown' };
  const hash = hashToken(refreshToken);
  const now = new Date();

  // CONSUME ATOMICALLY. The WHERE carries the single-use condition, so exactly
  // one concurrent caller can win it — Postgres serialises the row update and
  // the loser matches zero rows.
  //
  // Reading the row first and then updating it (the previous shape) left a
  // window between the two statements. Under READ COMMITTED, two simultaneous
  // replays of a stolen token both saw refresh_rotated_at IS NULL, both passed
  // the reuse check and both minted a session — so the tripwire this whole
  // function exists to arm never fired, in precisely the case it was built for.
  const [consumed] = await db.update(session)
    .set({ refreshRotatedAt: now, revokedAt: now, revokeReason: 'rotated' })
    .where(and(
      eq(session.refreshHash, hash),
      isNull(session.refreshRotatedAt),
      isNull(session.revokedAt),
    ))
    .returning();

  if (consumed === undefined) {
    // Nothing consumable. Distinguish the three reasons from the row's state —
    // reads only, the decision has already been made by the UPDATE above.
    const [existing] = await db.select().from(session)
      .where(eq(session.refreshHash, hash)).limit(1);
    if (existing?.refreshHash == null || !eqHash(existing.refreshHash, hash)) {
      return { ok: false, reason: 'unknown' };
    }
    // REUSE: the row exists and was already rotated. Someone is replaying a
    // token that was spent. Revoke the whole family, uniformly and loudly.
    if (existing.refreshRotatedAt !== null) {
      await db.update(session)
        .set({ revokedAt: new Date(), revokeReason: 'refresh token reuse detected' })
        .where(eq(session.familyId, existing.familyId));
      return { ok: false, reason: 'reused' };
    }
    return { ok: false, reason: 'revoked' };
  }

  const row = consumed;
  if (row.refreshHash === null || !eqHash(row.refreshHash, hash)) return { ok: false, reason: 'unknown' };

  // Family age counts from FIRST issuance, so rotation cannot extend the window.
  if (row.issuedAt.getTime() + REFRESH_TTL_SECONDS * 1000 < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  const sessionToken = generateToken();
  const nextRefresh = generateToken();
  const expiresAt = new Date(Date.now() + ACCESS_TTL_SECONDS * 1000);

  // The successor joins the same family, carrying the original issuedAt.
  const [fresh] = await db.insert(session).values({
    userId: row.userId,
    tenantId: row.tenantId,
    familyId: row.familyId,
    tokenHash: hashToken(sessionToken),
    refreshHash: hashToken(nextRefresh),
    issuedAt: row.issuedAt,
    expiresAt,
    ip: row.ip,
    userAgent: row.userAgent,
    idpSessionId: row.idpSessionId,
  }).returning({ id: session.id });
  if (!fresh) throw new Error('rotation insert returned no row');

  return { ok: true, issued: { sessionId: fresh.id, sessionToken, refreshToken: nextRefresh, expiresAt } };
}

export async function revokeSession(db: Db | Tx, sessionId: string, reason = 'sign out'): Promise<void> {
  await db.update(session).set({ revokedAt: new Date(), revokeReason: reason }).where(eq(session.id, sessionId));
}

/** Offboarding: revoke everything for a user at once (AUTH-SPEC.md §10.2). */
export async function revokeAllSessions(db: Db | Tx, userId: string, reason: string): Promise<number> {
  const res = await db.update(session)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(and(eq(session.userId, userId), isNull(session.revokedAt)))
    .returning({ id: session.id });
  return res.length;
}

/** Count live sessions, for a "your devices" view. */
export async function activeSessionCount(db: Db | Tx, userId: string): Promise<number> {
  const [row] = await db.select({ c: sql<number>`count(*)::int` })
    .from(session)
    .where(and(eq(session.userId, userId), isNull(session.revokedAt), sql`${session.expiresAt} > now()`));
  return row?.c ?? 0;
}

/**
 * Delete sessions that expired before `olderThan`.
 *
 * Rows are only ever revoked, never removed, so the table grows without bound —
 * one row per sign-in plus one per refresh rotation, forever. Indexed lookup
 * (see resolveSession) means growth no longer costs per-request latency, but it
 * still costs storage and backup time, and a session table nobody prunes is a
 * standing reminder that nobody is looking.
 *
 * Deliberately NOT wired to a scheduler here: what cadence to run it at, and
 * whether to retain revoked rows for forensics first, are operational decisions
 * that belong with the M2 deployment rather than in this module.
 */
export async function pruneExpiredSessions(db: Db | Tx, olderThan: Date): Promise<number> {
  const removed = await db.delete(session)
    .where(sql`${session.expiresAt} < ${olderThan}`)
    .returning({ id: session.id });
  return removed.length;
}
