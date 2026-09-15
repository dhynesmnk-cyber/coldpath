import { JUNK, LEGAL_SUFFIXES, normName } from './normalise.js';

/**
 * Canonical parent-company map, ported verbatim from
 * phase1/connectors/epa_rmp.py (CANONICAL_PARENTS).
 *
 * In production this is a database table maintained by the marketer, seeded from
 * this list. It is the first of three resolution passes; fuzzy matching is the
 * second and the human queue is the third.
 */
export const CANONICAL_PARENTS: readonly (readonly [pattern: RegExp, canonical: string])[] = [
  [/americold/, 'Americold Realty Trust'],
  [/lineage/, 'Lineage, Inc.'],
  [/united states cold storage|us cold storage/, 'United States Cold Storage'],
  [/^kroger|the kroger/, 'The Kroger Co.'],
  [/^sysco/, 'Sysco Corporation'],
  [/u\.?s\.? foods/, 'US Foods Holding Corp.'],
  [/performance food/, 'Performance Food Group'],
  [/c&s wholesale/, 'C&S Wholesale Grocers'],
  [/costco/, 'Costco Wholesale Corporation'],
  [/tyson/, 'Tyson Foods, Inc.'],
  [/jbs/, 'JBS USA'],
  [/wal-?mart/, 'Walmart Inc.'],
  [/cargill/, 'Cargill, Inc.'],
  [/hormel/, 'Hormel Foods Corporation'],
  [/aldi/, 'ALDI US'],
  [/koch foods/, 'Koch Foods'],
  [/saputo/, 'Saputo Inc.'],
  [/nestl/, 'Nestlé USA'],
  [/publix/, 'Publix Super Markets'],
  [/dollar general/, 'Dollar General'],
  [/gordon food/, 'Gordon Food Service'],
  [/dot foods/, 'DOT Foods'],
  [/united natural foods/, 'United Natural Foods Inc.'],
  [/safeway|albertsons/, 'Albertsons/Safeway'],
  [/schwan/, "Schwan's Company"],
  [/stouffer/, 'Nestlé USA (Stouffer)'],
  [/prairie farms/, 'Prairie Farms Dairy'],
  [/dfa dairy|pet dairy/, 'Dairy Farmers of America'],
  [/united global foods/, 'United Global Foods'],
  [/tippmann/, 'Tippmann Group'],
  [/taylor fresh/, 'Taylor Fresh Foods'],
  [/boar.s head/, "Boar's Head"],
  [/rich products/, 'Rich Products'],
  [/pictsweet/, 'Pictsweet Farms'],
];

/** Existing customers. In production this comes from the CRM, never hardcoded. */
export const KNOWN_CUSTOMERS: ReadonlySet<string> = new Set([
  'Americold Realty Trust',
  'Lineage, Inc.',
  'United States Cold Storage',
]);

/**
 * Separators sit BETWEEN two tokens; joiners sit INSIDE one. Only displayName
 * needs the distinction — see the note on matchKey about why the key does not.
 */
const SEPARATORS = /[-/_,]/g;
const JOINERS = /['’.]/g;

/**
 * Bucketing key: case-folded, legal suffixes stripped, and every character that
 * is not a letter, digit or ampersand removed — INCLUDING spaces.
 *
 * Two names that differ only by case, apostrophes, hyphens or legal suffix must
 * produce the SAME key, or one company splits into two accounts. Both halves of
 * that sentence have been violated in production code:
 *
 *   1. The first version of this port lowercased the fallback path while the
 *      canonical-rule path returned title case, so "Dairy Farmers of America"
 *      arrived as two separate accounts (9 and 4 sites) instead of one with 13.
 *   2. The second deleted punctuation but KEPT spaces, so "Save-A-Lot" keyed as
 *      "savealot" and did not match "Save A Lot". That was documented as
 *      deferred to the human resolution queue — but the deferral never happened.
 *      A company split into halves that each fall below the multi-site pilot
 *      filter is dropped from the output entirely and reaches no queue at all.
 *      On the live 1,382-facility pull that silently lost MDV/SpartanNash and
 *      Save-A-Lot, under-counted H-E-B (5 sites reported as 4), and listed
 *      Wayne-Sanderson Farms twice as if it were two companies.
 *
 * Dropping spaces too is what makes the key robust rather than merely different.
 * A hyphen is ambiguous — it stands for a space in "Wayne-Sanderson Farms" and
 * for nothing in "Nor-Am Cold Storage" — so any rule that maps it to one or the
 * other fixes half the cases and breaks the other half. Ignoring the distinction
 * entirely is the only treatment that is correct for both.
 *
 * Measured across all 609 distinct reported names in the live pull: 511 buckets
 * -> 506, five merge groups, every one a genuine same-company pair, and no two
 * distinct companies merged.
 *
 * The cost is a key no human can read. That is fine — nobody reads it. Account
 * names come from displayName, and the aliases column records every spelling
 * that was folded in.
 */
export function matchKey(name: string): string {
  return name
    .toLowerCase()
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/[^a-z0-9&]/g, '');
}

/**
 * Display name: same punctuation rule, preserving the reported capitalisation,
 * so canonical account names read as proper nouns rather than as match keys.
 *
 * Deliberately does NOT collapse single-character runs the way matchKey does. A
 * key is never read by a human and only has to be stable; a display name is read
 * by a marketer, and collapsing would turn "U. S. Foods" into "US Foods". Removing
 * joiners rather than spacing them is what keeps "Bozzuto's" rendering as
 * "Bozzutos" instead of "Bozzuto s".
 */
export function displayName(name: string): string {
  return name
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(SEPARATORS, ' ')
    .replace(JOINERS, '')
    .replace(/[^A-Za-z0-9& ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Canonicalised {
  /** Bucketing key. Two reported names for one company produce the same key. */
  readonly key: string;
  /** Human-readable account name. */
  readonly name: string;
  /** Whether a canonical rule matched, or the name fell through to normalisation. */
  readonly by: 'rule' | 'fallback';
}

/**
 * Resolve a reported parent/operator/facility name.
 * Returns null when the name is unusable, so the caller routes the facility to
 * the human review queue instead of inventing an account.
 */
export function canonicaliseParent(name: string | null | undefined): Canonicalised | null {
  if (typeof name !== 'string') return null;
  const low = name.toLowerCase();
  for (const [pattern, canonical] of CANONICAL_PARENTS) {
    if (pattern.test(low)) return { key: matchKey(canonical), name: canonical, by: 'rule' };
  }
  const key = matchKey(name);
  // Junk check, NOT a minimum-length check. A length rule wrongly rejected the
  // real companies `JDB, Inc.` (BrucePac's reported parent) and `ACS-LLC`.
  if (key.length === 0 || JUNK.has(key)) return null;
  const shown = displayName(name);
  if (shown.length === 0) return null;
  return { key, name: shown, by: 'fallback' };
}

/** Backwards-compatible string form for callers that only need the name. */
export function canonicalName(name: string | null | undefined): string | null {
  return canonicaliseParent(name)?.name ?? null;
}

export { normName };
