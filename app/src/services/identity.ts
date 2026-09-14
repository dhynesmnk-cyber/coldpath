import { and, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { tenantCtx, withTenant, type Db, type Tx } from '../db/client.js';
import { account, appUser, piiGrant, roleGrant, type AppUser } from '../db/schema/index.js';
import { createSession, revokeAllSessions, type IssuedSession } from '../lib/auth/session.js';
import { AuthError, type IdpProfile, type Role } from '../lib/auth/types.js';
import { audit } from './audit.js';

/**
 * Identity lifecycle — AUTH-SPEC.md §5, §10.
 *
 * The IdP is the source of truth for WHO someone is; COLDPATH is the source of
 * truth for WHAT they may do. Provisioning therefore never invents a role: a
 * brand-new user exists with zero grants and is refused until an admin or a
 * group mapping says otherwise (spec §3, principle 2: fail closed).
 *
 * Group-derived vs. hand-granted roles are distinguished by `granted_by`:
 *   - granted_by IS NULL  → synced from IdP groups; this file may revoke it.
 *   - granted_by IS NOT NULL → an admin granted it (role.grant); sync never
 *     touches it, so removing a group cannot strip a deliberately granted role
 *     and adding one cannot resurrect an admin's explicit revocation... except
 *     that a re-sync WILL re-grant a role the group still maps to. That is the
 *     intended semantics: groups are authoritative for what groups say.
 */

export type GroupRoleMap = Readonly<Record<string, Role | readonly Role[]>>;

/** Pure: which roles does this group membership imply? */
export function mapGroupsToRoles(groups: readonly string[], map: GroupRoleMap): Role[] {
  const out = new Set<Role>();
  for (const g of groups) {
    const mapped = map[g];
    if (mapped === undefined) continue;
    const roles = typeof mapped === 'string' ? [mapped] : [...mapped];
    for (const r of roles) out.add(r);
  }
  return [...out];
}

/** "Madeline Belvin" → "MB"; no usable name → null (UI falls back to email). */
export function deriveInitials(name: string | null): string | null {
  const source = name?.trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] ?? '';
    const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
    const initials = (first + last).toUpperCase();
    if (initials.length > 0) return initials;
  }
  return null;
}

export interface ProvisionedUser {
  readonly user: AppUser;
  readonly created: boolean;
}

/**
 * Upsert by (tenant, idpSubject) — the subject is the stable key, never the
 * email (spec §5: people change names; subjects do not change).
 *
 * A locally deactivated user is NOT reactivated by logging in. Offboarding is
 * an explicit act and only an admin undoing it (is_active=true) reverses it;
 * otherwise deleting someone from the IdP and them re-appearing via a stale
 * group would silently resurrect access.
 */
export async function provisionUser(
  db: Db | Tx,
  p: { tenantId: string; profile: IdpProfile },
): Promise<ProvisionedUser> {
  const displayName = p.profile.name ?? p.profile.email.split('@')[0] ?? p.profile.email;
  const initials = deriveInitials(p.profile.name);

  const [existing] = await db.select().from(appUser)
    .where(and(eq(appUser.tenantId, p.tenantId), eq(appUser.idpSubject, p.profile.subject)));

  if (existing === undefined) {
    const [created] = await db.insert(appUser).values({
      tenantId: p.tenantId,
      idpSubject: p.profile.subject,
      email: p.profile.email,
      displayName,
      initials,
    }).returning();
    if (!created) throw new Error('app_user insert returned no row');
    return { user: created, created: true };
  }

  const [updated] = await db.update(appUser).set({
    email: p.profile.email,
    displayName,
    initials,
    lastSeenAt: new Date(),
  }).where(eq(appUser.id, existing.id)).returning();
  return { user: updated ?? existing, created: false };
}

export interface RoleSyncResult {
  readonly granted: Role[];
  readonly revoked: Role[];
}

/**
 * Reconcile group-derived role grants with current IdP groups (spec §10.1,
 * acceptance test #7). Idempotent; safe on every sign-in. Only touches grants
 * with granted_by IS NULL — see the file header for why that is the seam.
 */
export async function syncGroupRoles(
  db: Db | Tx,
  p: { tenantId: string; userId: string; groups: readonly string[]; map: GroupRoleMap; actorNote?: string },
): Promise<RoleSyncResult> {
  const desired = mapGroupsToRoles(p.groups, p.map);

  const current = await db.select({ role: roleGrant.role, id: roleGrant.id, grantedBy: roleGrant.grantedBy })
    .from(roleGrant)
    .where(and(eq(roleGrant.userId, p.userId), eq(roleGrant.tenantId, p.tenantId), isNull(roleGrant.grantedBy)));

  const currentRoles = current.map((g) => g.role);
  const toRevoke = currentRoles.filter((r) => !desired.includes(r));
  const toGrant = desired.filter((r) => !currentRoles.includes(r));

  if (toRevoke.length > 0) {
    await db.delete(roleGrant).where(and(
      eq(roleGrant.userId, p.userId),
      eq(roleGrant.tenantId, p.tenantId),
      isNull(roleGrant.grantedBy),
      inArray(roleGrant.role, toRevoke),
    ));
    for (const role of toRevoke) {
      await audit(db, {
        tenantId: p.tenantId, userId: p.userId, action: 'role.revoke',
        resourceType: 'role_grant', resourceId: role, outcome: 'allow',
        reason: p.actorNote ?? 'group sync: no longer implied by IdP groups',
      });
    }
  }

  for (const role of toGrant) {
    await db.insert(roleGrant).values({
      tenantId: p.tenantId, userId: p.userId, role, grantedBy: null,
    }).onConflictDoNothing();
    await audit(db, {
      tenantId: p.tenantId, userId: p.userId, action: 'role.grant',
      resourceType: 'role_grant', resourceId: role, outcome: 'allow',
      reason: p.actorNote ?? 'group sync: implied by IdP groups',
    });
  }

  return { granted: toGrant, revoked: toRevoke };
}

export interface SignInResult {
  readonly user: AppUser;
  readonly roles: Role[];
  readonly session: IssuedSession;
  readonly created: boolean;
}

/**
 * The full login: provision → sync groups → check the result → issue session.
 *
 * Runs as TWO committed transactions, and that shape is load-bearing:
 *
 *   TX1  provision + group sync + refusal audit (if any) — ALWAYS commits.
 *   TX2  session issuance + login audit — only on success.
 *
 * If a denied sign-in (zero roles, deactivated) threw inside a single
 * transaction, the rollback would undo the group sync — removing a user from
 * the IdP group would then NOT remove their role while an old session lives,
 * breaking acceptance test #7 in the quietest possible way. Refusals are
 * therefore recorded as data, committed, and only then thrown as AuthError.
 *
 * Takes the raw `Db`, not a `Tx`: this function owns its transaction
 * boundaries. Do not call it inside withTenant.
 */
export async function signIn(
  db: Db,
  p: {
    tenantId: string;
    profile: IdpProfile;
    groupRoleMap: GroupRoleMap;
    ip?: string | null;
    userAgent?: string | null;
    idpSessionId?: string | null;
  },
): Promise<SignInResult> {
  const tenant = tenantCtx(p.tenantId);

  const outcome = await withTenant(db, tenant, async (tx) => {
    const { user, created } = await provisionUser(tx, { tenantId: p.tenantId, profile: p.profile });

    if (!user.isActive) {
      // Offboarding is an explicit act; IdP authentication does not resurrect.
      await audit(tx, {
        tenantId: p.tenantId, userId: user.id, action: 'auth.denied',
        resourceType: 'app_user', resourceId: user.id, outcome: 'deny',
        reason: 'user is deactivated locally; IdP authentication does not reactivate',
        ip: p.ip ?? null, userAgent: p.userAgent ?? null,
      });
      return { kind: 'denied' as const, code: 'inactive' as const, message: 'account is deactivated' };
    }

    const sync = await syncGroupRoles(tx, {
      tenantId: p.tenantId, userId: user.id, groups: p.profile.groups, map: p.groupRoleMap,
    });

    const roles = await activeRoles(tx, p.tenantId, user.id);
    if (roles.length === 0) {
      // Not an IdP failure — the directory vouches for the person, but
      // COLDPATH has granted them nothing. Spec §3: no default role.
      await audit(tx, {
        tenantId: p.tenantId, userId: user.id, action: 'auth.denied',
        resourceType: 'app_user', resourceId: user.id, outcome: 'deny',
        reason: 'authenticated but zero roles granted (groups: ' + (p.profile.groups.join(', ') || 'none') + ')',
        ip: p.ip ?? null, userAgent: p.userAgent ?? null,
      });
      return {
        kind: 'denied' as const,
        code: 'forbidden' as const,
        message: 'no roles granted — ask an administrator for access',
      };
    }

    return { kind: 'ok' as const, user, roles, created, sync };
  });

  if (outcome.kind === 'denied') {
    throw new AuthError(outcome.code, outcome.message);
  }

  return withTenant(db, tenant, async (tx) => {
    const session = await createSession(tx, {
      userId: outcome.user.id,
      tenantId: p.tenantId,
      ...(p.ip !== undefined ? { ip: p.ip } : {}),
      ...(p.userAgent !== undefined ? { userAgent: p.userAgent } : {}),
      ...(p.idpSessionId !== undefined ? { idpSessionId: p.idpSessionId } : {}),
    });

    await audit(tx, {
      tenantId: p.tenantId, userId: outcome.user.id, action: 'auth.login',
      resourceType: 'session', resourceId: session.sessionId, outcome: 'allow',
      ip: p.ip ?? null, userAgent: p.userAgent ?? null,
      meta: {
        created: outcome.created,
        rolesGranted: outcome.sync.granted,
        rolesRevoked: outcome.sync.revoked,
        subject: p.profile.subject,
      },
    });

    return { user: outcome.user, roles: outcome.roles, session, created: outcome.created };
  });
}

/** Roles currently in force for a user (unexpired grants only). */
async function activeRoles(db: Db | Tx, tenantId: string, userId: string): Promise<Role[]> {
  const grants = await db.select({ role: roleGrant.role, expiresAt: roleGrant.expiresAt })
    .from(roleGrant)
    .where(and(eq(roleGrant.userId, userId), eq(roleGrant.tenantId, tenantId)));
  const now = new Date();
  return grants.filter((g) => g.expiresAt === null || g.expiresAt > now).map((g) => g.role);
}

export interface OffboardResult {
  readonly sessionsRevoked: number;
  readonly roleGrantsExpired: number;
  readonly piiGrantsExpired: number;
}

/**
 * Offboarding — AUTH-SPEC.md §10.2, acceptance test #12.
 *
 * Deactivate, expire every grant, revoke every session. What we do NOT do:
 * delete the user row or reassign their history. Their captures, corrections
 * and audit entries stay attributed to them forever — attribution that dies
 * with the account is not attribution.
 */
export async function offboardUser(
  db: Db | Tx,
  p: { tenantId: string; userId: string; reason: string; actorId?: string | null },
): Promise<OffboardResult> {
  const now = new Date();

  const [user] = await db.select().from(appUser)
    .where(and(eq(appUser.id, p.userId), eq(appUser.tenantId, p.tenantId)));
  if (user === undefined) throw new Error(`no such user in tenant: ${p.userId}`);

  await db.update(appUser).set({ isActive: false }).where(eq(appUser.id, p.userId));

  const roles = await db.update(roleGrant)
    .set({ expiresAt: now })
    .where(and(
      eq(roleGrant.userId, p.userId),
      eq(roleGrant.tenantId, p.tenantId),
      // gt(), not a raw sql template. Interpolating a JS Date into sql`...`
      // binds it without the column's type mapping: PGlite tolerates that,
      // postgres.js throws ERR_INVALID_ARG_TYPE, and offboarding therefore
      // failed on a real server while passing every test. See
      // scripts/verify-postgres.ts for why this is now caught.
      or(isNull(roleGrant.expiresAt), gt(roleGrant.expiresAt, now)),
    ))
    .returning({ id: roleGrant.id });

  // #12: a deactivated user's pii_grant rows must stop authorizing. Expiring
  // them is belt; hasActivePiiGrant re-checking user is_active is braces.
  const piis = await db.update(piiGrant)
    .set({ expiresAt: now })
    .where(and(
      eq(piiGrant.userId, p.userId),
      eq(piiGrant.tenantId, p.tenantId),
      or(isNull(piiGrant.expiresAt), gt(piiGrant.expiresAt, now)),
    ))
    .returning({ id: piiGrant.id });

  const sessionsRevoked = await revokeAllSessions(db, p.userId, `offboarded: ${p.reason}`);

  await audit(db, {
    tenantId: p.tenantId, userId: p.actorId ?? null, action: 'role.revoke',
    resourceType: 'app_user', resourceId: p.userId, outcome: 'allow',
    reason: `offboarded: ${p.reason}`,
    meta: { sessionsRevoked, roleGrantsExpired: roles.length, piiGrantsExpired: piis.length },
  });

  return { sessionsRevoked, roleGrantsExpired: roles.length, piiGrantsExpired: piis.length };
}

/**
 * Does this user hold a LIVE grant for this person-field? Consulted at read
 * time (gate S5 / consentBasisPresent), never cached in a session — expiry and
 * offboarding must take effect on the next request, not the next login.
 */
export async function hasActivePiiGrant(
  db: Db | Tx,
  p: { tenantId: string; userId: string; personId: string; field: 'email' | 'phone' },
): Promise<boolean> {
  const rows = await db.select({ id: piiGrant.id })
    .from(piiGrant)
    .innerJoin(appUser, eq(appUser.id, piiGrant.userId))
    .where(and(
      eq(piiGrant.tenantId, p.tenantId),
      eq(piiGrant.userId, p.userId),
      eq(piiGrant.personId, p.personId),
      eq(piiGrant.field, p.field),
      eq(appUser.isActive, true),
      or(isNull(piiGrant.expiresAt), sql`${piiGrant.expiresAt} > now()`),
    ))
    .limit(1);
  return rows.length > 0;
}

export interface OrphanedAccount {
  readonly id: string;
  readonly canonicalName: string;
  readonly reason: 'unowned' | 'owner_inactive';
}

/**
 * Gate C6 / acceptance test #13: accounts whose owner is gone surface in the
 * unassigned queue instead of rotting silently. "Gone" means never assigned or
 * deactivated — offboarding the sole owner must not strand the account.
 */
export async function orphanedAccounts(db: Db | Tx, tenantId: string): Promise<OrphanedAccount[]> {
  const rows = await db
    .select({
      id: account.id,
      canonicalName: account.canonicalName,
      ownerId: account.ownerId,
    })
    .from(account)
    .leftJoin(appUser, eq(appUser.id, account.ownerId))
    .where(and(
      eq(account.tenantId, tenantId),
      ne(account.status, 'excluded'),
      or(isNull(account.ownerId), eq(appUser.isActive, false)),
    ));
  return rows.map((r) => ({
    id: r.id,
    canonicalName: r.canonicalName,
    reason: r.ownerId === null ? 'unowned' as const : 'owner_inactive' as const,
  }));
}
