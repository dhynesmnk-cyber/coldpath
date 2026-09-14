import { type Permission, type Role, ROLES } from './types.js';

/**
 * The permission matrix from AUTH-SPEC.md §6, expressed as data so it can be
 * tested exhaustively rather than reasoned about.
 *
 * Two rules the shape of this table encodes deliberately:
 *   - `rep` never sees drafts, because `rep` cannot create or promote one. That
 *     is the review gate expressed as a permission rather than as a convention.
 *   - `admin` alone reads the audit log. Marketing administers the records the
 *     audit log describes; separation of duties is the point.
 */
const MATRIX: Record<Permission, readonly Role[]> = {
  'library.read':          ROLES,
  'library.search':        ROLES,
  'correction.create':     ['admin', 'marketing', 'sales_lead', 'rep'],
  'brief.request':         ['admin', 'marketing', 'sales_lead', 'rep'],
  'capture.create':        ['admin', 'marketing', 'sales_lead', 'rep'],
  // Role gate only. The ownership check is separate — see canAccessPii.
  'pii.read':              ['admin', 'marketing', 'sales_lead', 'rep'],
  'dashboard.view':        ['admin', 'marketing', 'sales_lead'],
  'research.read':         ['admin', 'marketing', 'sales_lead'],
  'ingest.execute':        ['admin', 'marketing'],
  'review.approve':        ['admin', 'marketing'],
  'deliverable.publish':   ['admin', 'marketing'],
  'review.resolve':        ['admin', 'marketing'],
  'account.assign':        ['admin', 'marketing', 'sales_lead'],
  'cost.read':             ['admin', 'marketing'],
  'role.grant':            ['admin'],
  'audit.read':            ['admin'],
  'customer_list.manage':  ['admin', 'marketing'],
};

/** Effective permission is the union of granted roles. */
export function can(roles: readonly Role[], permission: Permission): boolean {
  const allowed = MATRIX[permission];
  return roles.some((r) => allowed.includes(r));
}

/** The full permission set for a role — used by the UI to hide what will be refused. */
export function permissionsFor(roles: readonly Role[]): Permission[] {
  return (Object.keys(MATRIX) as Permission[]).filter((p) => can(roles, p));
}

/**
 * T3 access (AUTH-SPEC.md §7): gated PII is visible to admin and marketing
 * globally, and to sales_lead/rep ONLY for accounts they own.
 *
 * `isOwner` is supplied by the caller from the account record (gate C6), so this
 * function stays pure and unit-testable.
 */
export function canAccessPii(
  roles: readonly Role[],
  ctx: { readonly isOwner: boolean; readonly consentBasisPresent: boolean },
): boolean {
  if (!can(roles, 'pii.read')) return false;
  if (roles.includes('admin') || roles.includes('marketing')) {
    // Still requires a recorded lawful basis before the value can be USED for
    // outbound (gate S5). Reading for research and sending are different acts.
    return true;
  }
  return ctx.isOwner;
}

/**
 * Whether a contact detail may be used to generate outbound. Distinct from
 * reading it: gate S5 requires a recorded lawful basis, gate L8 blocks outbound
 * entirely for contacts below confidence 2.
 */
export function canUseForOutbound(
  roles: readonly Role[],
  ctx: { readonly isOwner: boolean; readonly consentBasisPresent: boolean; readonly confidence: number },
): boolean {
  if (!canAccessPii(roles, ctx)) return false;
  return ctx.consentBasisPresent && ctx.confidence >= 3;
}

export { MATRIX };
