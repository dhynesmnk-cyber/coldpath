import { type Principal, type Tier, TIER_RANK } from './types.js';
import { can, canAccessPii } from './permissions.js';

/**
 * Field-level data classification — AUTH-SPEC.md §7.
 *
 * Screen-level access is not sufficient: one deliverable can contain both T2
 * research and T3 contact details. Classification is therefore per FIELD and
 * enforced at serialization, which is the last place data can still be withheld.
 *
 *   T0  derived public data          any authenticated user
 *   T1  internal analysis             rep and above
 *   T2  research + published output   rep and above (drafts: marketing and above)
 *   T3  gated PII                     owner / sales_lead / marketing / admin, logged
 *   T4  customer list                 marketing / admin, NEVER serialized to output
 */
export const FIELD_TIERS = {
  account: {
    canonicalName: 'T1', vertical: 'T1', hq: 'T0', website: 'T0', ticker: 'T0',
    icpScore: 'T1', icpComponents: 'T1', status: 'T1', priority: 'T1',
    ownerId: 'T1', repId: 'T1', researchState: 'T1', researchedAt: 'T1',
    refreshDueAt: 'T1', crmId: 'T1',
    // The single most sensitive flag in the system. Gate C5 uses it to suppress
    // rows; it is never itself content, in any artefact, for any role below
    // marketing. Structural control, not a filter.
    isCustomer: 'T4',
  },
  person: {
    name: 'T1', title: 'T1', roleInDeal: 'T1', confidence: 'T1', isGap: 'T1',
    gapReason: 'T1', resolutionPath: 'T1', angle: 'T1', provenance: 'T1',
    asOf: 'T1', linkedinUrl: 'T2', verifiedAt: 'T1',
    email: 'T3', phone: 'T3',
  },
  deliverable: {
    type: 'T1', version: 'T1', status: 'T1', minConfidence: 'T1',
    blockedReason: 'T1', authorId: 'T1', approvedBy: 'T1', publishedAt: 'T1',
    // The body is T2 when published; drafts are restricted by a separate rule
    // because a rep must never see an unapproved artefact.
    body: 'T2', rendered: 'T2',
  },
  site: {
    name: 'T0', city: 'T0', state: 'T0', rto: 'T0', naics: 'T0', ammoniaLb: 'T0',
    programLevel: 'T0', accidents: 'T0', recentAccidents: 'T0', submissions: 'T0',
    rmpId: 'T0', lat: 'T0', lon: 'T0', url: 'T0', validated: 'T1', validationNote: 'T1',
  },
  signal: {
    type: 'T1', occurredOn: 'T1', title: 'T1', detail: 'T1', impact: 'T1',
    whyItMatters: 'T1', detectedAt: 'T1',
  },
  costEvent: { operation: 'T1', units: 'T1', cost: 'T1', tokensIn: 'T1', tokensOut: 'T1', note: 'T1' },
  auditLog: { action: 'T4', outcome: 'T4', reason: 'T4', userId: 'T4', ip: 'T4', meta: 'T4' },
} as const satisfies Record<string, Record<string, Tier>>;

export type EntityName = keyof typeof FIELD_TIERS;

export interface AccessContext {
  /** Gate C6 ownership — does this principal own the account the record belongs to? */
  readonly isOwner: boolean;
  /** Gate S5 — is a lawful basis recorded for this contact detail? */
  readonly consentBasisPresent: boolean;
  /** Gate L7/L8 — confidence of the underlying record, 1..3. */
  readonly confidence: number;
}

export interface SerialiseOptions {
  readonly entity: EntityName;
  readonly ctx?: Partial<AccessContext>;
  /** True when the output is a deliverable or export rather than an internal screen. */
  readonly forExport?: boolean;
  /** Called for every T3 field actually emitted, so the read can be audited. */
  readonly onPiiRead?: (field: string) => void;
}

const DEFAULT_CTX: AccessContext = { isOwner: false, consentBasisPresent: false, confidence: 1 };

/**
 * Minimum tier a role may read at all.
 *
 * `pii.read` raises the ceiling to T3 for rep/sales_lead, but reaching the
 * ceiling is not the same as passing the gate: every T3 field still goes
 * through canAccessPii (ownership for rep/sales_lead, global for
 * marketing/admin) before it is emitted. Without the ceiling raise, an owning
 * rep would be locked out of gated PII by role tier alone — contradicting
 * AUTH-SPEC §7, which lists the OWNER first.
 */
function maxTierFor(principal: Principal | null): number {
  if (principal === null) return -1;                 // unauthenticated: nothing
  if (!principal.isActive) return -1;                 // offboarded: nothing
  if (can(principal.roles, 'customer_list.manage')) return TIER_RANK.T4;
  if (can(principal.roles, 'research.read')) return TIER_RANK.T3;
  if (can(principal.roles, 'pii.read')) return TIER_RANK.T3;
  if (can(principal.roles, 'library.read')) return TIER_RANK.T2;
  return -1;
}

/**
 * Serialize a record for a principal, OMITTING fields they may not see.
 *
 * Omitted, not masked and not nulled. A masked value (`j***@acme.com`) still
 * confirms the record exists and leaks its shape; null is indistinguishable from
 * "no data". Absence leaks nothing and cannot be undone client-side.
 */
export function serialise<T extends object>(
  record: T,
  opts: SerialiseOptions,
  principal: Principal | null,
): Partial<T> {
  const policy = FIELD_TIERS[opts.entity] as Record<string, Tier>;
  const ctx: AccessContext = { ...DEFAULT_CTX, ...opts.ctx };
  const ceiling = maxTierFor(principal);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    const tier = policy[key];
    if (tier === undefined) continue;                 // unmapped field: omit by default
    if (TIER_RANK[tier] > ceiling) continue;

    // T4 never leaves in an artefact or export, for anyone. It is used to
    // suppress rows (gate C5), not to be read.
    if (tier === 'T4' && opts.forExport === true) continue;

    if (tier === 'T3') {
      if (principal === null) continue;
      if (!canAccessPii(principal.roles, { isOwner: ctx.isOwner, consentBasisPresent: ctx.consentBasisPresent })) continue;
      if (value === null || value === undefined) continue;
      opts.onPiiRead?.(key);
    }

    // A rep sees published deliverables only; drafts are marketing-and-above.
    if (opts.entity === 'deliverable' && (key === 'body' || key === 'rendered')) {
      const status = (record as { status?: string }).status;
      const isDraftish = status === 'draft' || status === 'in_review' || status === 'blocked';
      if (isDraftish && principal !== null && !can(principal.roles, 'review.approve')) continue;
    }

    out[key] = value;
  }
  return out as Partial<T>;
}

/** Which fields would this principal actually receive? Useful for tests and UI. */
export function visibleFields(entity: EntityName, principal: Principal | null, ctx?: Partial<AccessContext>): string[] {
  const policy = FIELD_TIERS[entity] as Record<string, Tier>;
  const probe = Object.fromEntries(Object.keys(policy).map((k) => [k, k === 'email' || k === 'phone' ? 'x' : 1])) as Record<string, unknown>;
  // exactOptionalPropertyTypes forbids passing `ctx: undefined` explicitly.
  const opts: SerialiseOptions = ctx === undefined ? { entity } : { entity, ctx };
  return Object.keys(serialise(probe, opts, principal));
}
