import { JUNK, LEGAL_SUFFIXES, normName } from './normalise.js';

/**
 * Canonical parent-company map, ported verbatim from
 * phase1/connectors/epa_rmp.py (CANONICAL_PARENTS).
 *
 * In production this is a database table maintained by the marketer, seeded from
 * this list. It is the first of three resolution passes; fuzzy matching is the
 * second and the human queue is the third.
 *
 * WHY THE PATTERNS ARE BUILT RATHER THAN WRITTEN LITERALLY — a measured defect.
 *
 * These were plain unanchored regexes tested with `.test()`. Because this pass
 * runs FIRST and returns immediately on a hit, it bypasses the distinctive-token
 * protection in match.ts entirely — a substring match here is final.
 *
 * `us cold storage` therefore matched "Sod-us cold storage": `Sodus Cold Storage
 * Co., Inc.` of Sodus, NY — an independent 14,693 lb single-site operator and a
 * genuine prospect — was absorbed into the United States Cold Storage account,
 * which is an existing CUSTOMER. It was silently suppressed from outbound with
 * no error and no review-queue entry. Same family: `aldi` matched Rinaldi,
 * Baldinger, Garibaldi and Aldine; `nestl` matched Nestlerode; `tyson` matched
 * Tysons Corner; `jbs` matched WJBS.
 *
 * This is INGESTION-GATES.md §9 #1 ("customer suppression must not over-reach",
 * blocking) and gate C5 ("suppression requires positive evidence"). The existing
 * regression test covered only the VersaCold case; the rule, not the instance,
 * is now enforced.
 *
 * The guards, and why they are asymmetric:
 *
 *   LEADING  — applied to every pattern, always. Nothing legitimate needs to
 *              begin matching in the middle of a word.
 *   TRAILING — applied only to names in WORD_FINAL. A blanket trailing guard
 *              would break two matches that are CORRECT: "U.S. Foodservice" is
 *              the former name of US Foods, and "Performance Foodservice" is
 *              Performance Food Group's operating brand. Both must keep
 *              resolving, so suffix continuation stays legal by default.
 *
 * guardPattern() below is exercised by a meta-test that asserts no
 * entry in this table can match mid-word, so a new row cannot reintroduce this.
 */

/**
 * Canonical names whose token is a complete word that must not absorb a suffix.
 * `tyson` must not match "Tysons Corner"; `nestle` must not match "Nestlerode".
 */
const WORD_FINAL: ReadonlySet<string> = new Set([
  // Short tokens that genuinely absorb a following word and land in the wrong
  // bucket: aldi/Aldine, tyson/Tysons Corner, jbs/WJBS, nestle/Nestlerode.
  'costco', 'tyson', 'jbs', 'hormel', 'aldi', 'saputo', 'publix', 'nestl[eé]',
  // Deliberately NOT here:
  //   schwan   — "SCHWANS COMPANY" is a legitimate continuation, and the guard
  //              only looked safe because matchKey() normalises both sides to
  //              `schwans` anyway. A guard whose safety depends on a downstream
  //              accident is worse than no guard: it moves the name onto the
  //              fallback path for no benefit.
  //   lineage, tippmann, pictsweet, stouffer, safeway, albertsons, sysco,
  //   kroger, cargill — long or already start-anchored; the leading guard
  //              alone is sufficient and no observed name continues them.
]);

/**
 * Compile one raw alternation into a regex that cannot match mid-word.
 *
 * Applied per alternative, not to the whole source: `safeway|albertsons` needs
 * a guard on each side of the pipe, not one wrapping the group.
 */
export function guardPattern(source: string): RegExp {
  const alternatives = source.split('|').map((alt) => {
    const startAnchored = alt.startsWith('^');
    const body = startAnchored ? alt.slice(1) : alt;
    // A leading '^' already prevents a mid-word start; otherwise guard it.
    const lead = startAnchored ? '^' : '(?<![a-z0-9])';
    const tail = WORD_FINAL.has(body) ? '(?![a-z0-9])' : '';
    return `${lead}${body}${tail}`;
  });
  return new RegExp(alternatives.join('|'));
}

/** The raw table. Sources are guarded by guardPattern, never used directly. */
const CANONICAL_PARENT_SOURCES: readonly (readonly [source: string, canonical: string])[] = [
  ['americold', 'Americold Realty Trust'],
  ['lineage', 'Lineage, Inc.'],
  ['united states cold storage|us cold storage', 'United States Cold Storage'],
  ['^kroger|the kroger', 'The Kroger Co.'],
  ['^sysco', 'Sysco Corporation'],
  ['u\\.?s\\.? foods', 'US Foods Holding Corp.'],
  ['performance food', 'Performance Food Group'],
  ['c&s wholesale', 'C&S Wholesale Grocers'],
  ['costco', 'Costco Wholesale Corporation'],
  ['tyson', 'Tyson Foods, Inc.'],
  ['jbs', 'JBS USA'],
  ['wal-?mart', 'Walmart Inc.'],
  ['cargill', 'Cargill, Inc.'],
  ['hormel', 'Hormel Foods Corporation'],
  ['aldi', 'ALDI US'],
  ['koch foods', 'Koch Foods'],
  ['saputo', 'Saputo Inc.'],
  ['nestl[eé]', 'Nestlé USA'],
  ['publix', 'Publix Super Markets'],
  ['dollar general', 'Dollar General'],
  ['gordon food', 'Gordon Food Service'],
  ['dot foods', 'DOT Foods'],
  ['united natural foods', 'United Natural Foods Inc.'],
  ['safeway|albertsons', 'Albertsons/Safeway'],
  ['schwan', "Schwan's Company"],
  ['stouffer', 'Nestlé USA (Stouffer)'],
  ['prairie farms', 'Prairie Farms Dairy'],
  ['dfa dairy|pet dairy', 'Dairy Farmers of America'],
  ['united global foods', 'United Global Foods'],
  ['tippmann', 'Tippmann Group'],
  ['taylor fresh', 'Taylor Fresh Foods'],
  ['boar.s head', "Boar's Head"],
  ['rich products', 'Rich Products'],
  ['pictsweet', 'Pictsweet Farms'],
];

/**
 * The compiled table. Every source passes through guardPattern, so anchoring is
 * a property of the structure rather than something each row has to remember.
 */
export const CANONICAL_PARENTS: readonly (readonly [pattern: RegExp, canonical: string])[] =
  CANONICAL_PARENT_SOURCES.map(([source, canonical]) => [guardPattern(source), canonical] as const);

/** Raw sources, exported so the meta-test can assert the guards hold. */
export { CANONICAL_PARENT_SOURCES };

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
const JOINERS = /['\u2019.]/g;

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

/**
 * Patterns as they were BEFORE guarding — used only to detect rescues below.
 * Built once; never used for resolution.
 */
const UNGUARDED_PATTERNS: readonly (readonly [RegExp, string])[] =
  CANONICAL_PARENT_SOURCES.map(([source, canonical]) => [new RegExp(source), canonical] as const);

export interface MergeRescue {
  /** The account this name would have been absorbed into without the guard. */
  readonly wouldBe: string;
  /** Whether that account is an existing customer — the damaging case. */
  readonly wouldBeCustomer: boolean;
}

/**
 * Did a pattern guard stop this name being absorbed into another account?
 *
 * This is the detector for the Sodus class. `us cold storage` is a substring of
 * "Sod-us cold storage", so before the guards Sodus Cold Storage Co. was filed
 * under United States Cold Storage — an existing CUSTOMER — and suppressed from
 * outbound with no error and no queue entry. The guard now prevents that, but
 * prevention is silent: nothing records that a near-miss occurred.
 *
 * COMPARES BUCKET KEYS, NOT CANONICAL NAMES, and that is the whole subtlety.
 * On names, "SCHWANS COMPANY" looks rescued — the guard moves it from the rule
 * path to the fallback path — but matchKey() normalises both to `schwans`, so it
 * lands in the same bucket and nothing was actually rescued. Comparing names
 * reports two hits on the current pull; comparing keys reports the one real one.
 */
export function mergeRescue(name: string | null | undefined): MergeRescue | null {
  if (typeof name !== 'string') return null;
  const low = name.toLowerCase();
  const hit = UNGUARDED_PATTERNS.find(([pattern]) => pattern.test(low));
  if (hit === undefined) return null;

  const [, wouldBe] = hit;
  const resolved = canonicaliseParent(name);
  if (resolved !== null && resolved.key === matchKey(wouldBe)) return null; // same bucket: no rescue

  return { wouldBe, wouldBeCustomer: KNOWN_CUSTOMERS.has(wouldBe) };
}
