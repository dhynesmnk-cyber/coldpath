/** Roles from AUTH-SPEC.md §6. Granted, never inherent; denials beat grants. */
export const ROLES = ['admin', 'marketing', 'sales_lead', 'rep', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Capabilities, not screens. Authorization is on the resource, so "can this user
 * read THIS contact's email" is expressible — see canAccessPii.
 */
export const PERMISSIONS = [
  'library.read', 'library.read_analysis', 'library.search', 'correction.create', 'brief.request',
  'capture.create', 'pii.read', 'dashboard.view', 'research.read',
  'ingest.execute', 'review.approve', 'deliverable.publish', 'review.resolve',
  'account.assign', 'cost.read', 'role.grant', 'audit.read', 'customer_list.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface Principal {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly displayName: string;
  readonly initials: string | null;
  readonly roles: readonly Role[];
  readonly isActive: boolean;
  readonly sessionId: string;
}

/**
 * Everything a request handler needs, built once per request by the middleware.
 * Services receive this rather than a framework request object, which is what
 * keeps them HTTP-agnostic (PRODUCT-PLAN.md §2.2).
 */
export interface RequestContext {
  readonly principal: Principal | null;
  readonly tenantId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export const ANONYMOUS: RequestContext = Object.freeze({
  principal: null, tenantId: null, ip: null, userAgent: null,
});

export type AuthErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'inactive'
  | 'tenant_missing'
  | 'session_revoked'
  /** The IdP interaction itself failed: bad discovery, bad exchange, or a token
   *  that did not validate. There is no fallback path — see oidc.ts. */
  | 'idp_error';

const UNAUTHENTICATED_CODES: ReadonlySet<AuthErrorCode> = new Set([
  'unauthenticated', 'session_revoked', 'inactive', 'idp_error',
]);

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly status: 401 | 403 = UNAUTHENTICATED_CODES.has(code) ? 401 : 403,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * The normalized identity an OIDC provider vouches for, after the library has
 * validated signature, issuer, audience, expiry and nonce. `subject` (never the
 * email) is the stable key — AUTH-SPEC.md §5.
 */
export interface IdpProfile {
  readonly subject: string;
  readonly email: string;
  readonly name: string | null;
  /** Directory group IDs/names from the configured group claim. */
  readonly groups: readonly string[];
  /** Full validated claim set, for audit metadata and debugging. */
  readonly claims: Readonly<Record<string, unknown>>;
}

/** Data classification tiers — AUTH-SPEC.md §7. */
export const TIERS = ['T0', 'T1', 'T2', 'T3', 'T4'] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_RANK: Record<Tier, number> = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4 };
