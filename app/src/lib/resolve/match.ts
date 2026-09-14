import { normName, tokenSim, tokens, typoSim } from './normalise.js';

/**
 * Distinctive-token matching.
 *
 * WHY THIS EXISTS — a measured defect, not a hypothetical one.
 *
 * The first resolver matched names by whole-string similarity. It matched
 * "VersaCold Logistics" to the registry alias "Americold Logistics" at 0.79 —
 * the edit distance between "versacold" and "americold" is only four characters.
 * Americold is an existing customer, so VersaCold (Loblaw's cold-chain
 * subsidiary, a genuine top-tier prospect) was silently suppressed as a customer
 * and vanished from the prospect list. No error, no queue item, one account short.
 *
 * The fix: a match requires at least one shared DISTINCTIVE token. Generic
 * industry words and weak discriminators are stripped first, and typo tolerance
 * applies only to distinctive tokens at >= 0.84 similarity.
 */

/** Industry words that carry no identifying information. */
export const GENERIC: ReadonlySet<string> = new Set([
  'logistics', 'logistic', 'cold', 'storage', 'stores', 'foods', 'food', 'group', 'holdings',
  'holding', 'companies', 'company', 'services', 'service', 'industries', 'industry',
  'international', 'global', 'national', 'systems', 'system', 'distribution', 'warehousing',
  'warehouse', 'frozen', 'refrigerated', 'partners', 'partner', 'enterprise', 'enterprises',
  'wholesale', 'grocers', 'grocery', 'dairy', 'farms', 'farm', 'meats', 'meat', 'poultry',
  'beef', 'pork', 'seafood', 'terminal', 'transport', 'trucking', 'lines', 'line',
  'provisions', 'provision', 'brands', 'brand', 'usa', 'american', 'the', 'and', 'of',
  'solutions', 'management', 'operating',
]);

/**
 * Tokens that look distinctive but are not. "United Global Foods" and "United
 * Natural Foods Inc." share only "united"; without this list they merge.
 */
export const WEAK: ReadonlySet<string> = new Set([
  'united', 'states', 'national', 'general', 'standard', 'premium', 'quality', 'first',
  'great', 'pacific', 'atlantic', 'central', 'western', 'eastern', 'northern', 'southern',
  'america', 'north', 'south',
]);

/** Minimum similarity for a typo-tolerant token match. */
export const TYPO_THRESHOLD = 0.84;
/** Minimum distinctive-token ratio to accept a fuzzy match. */
export const MATCH_MIN = 0.5;
/** Minimum overall score to accept a fuzzy match. */
export const SCORE_MIN = 0.62;
/** Two candidates within this margin are ambiguous, not resolved. */
export const AMBIGUITY_MARGIN = 0.12;

export function distinctive(input: string): string[] {
  return [...tokens(input)].filter((t) => !GENERIC.has(t) && t.length > 2);
}

export function strongTokens(input: string): string[] {
  return distinctive(input).filter((t) => t.length >= 5 && !WEAK.has(t));
}

export interface DistMatch {
  readonly ratio: number;
  readonly strongShared: number;
  readonly shared: number;
}

export function distMatch(a: string, b: string): DistMatch {
  const A = distinctive(a);
  const B = distinctive(b);
  if (A.length === 0 || B.length === 0) return { ratio: 0, strongShared: 0, shared: 0 };
  const Bset = new Set(B);
  let shared = 0;
  let typoShared = 0;
  for (const x of A) {
    if (Bset.has(x)) shared += 1;
    else if (x.length >= 5 && B.some((y) => y.length >= 5 && tokenSim(x, y) >= TYPO_THRESHOLD)) typoShared += 1;
  }
  const As = strongTokens(a);
  const Bs = strongTokens(b);
  const strongShared = As.filter((x) => Bs.includes(x) || Bs.some((y) => tokenSim(x, y) >= TYPO_THRESHOLD)).length;
  return {
    ratio: (shared + typoShared * 0.85) / Math.min(A.length, B.length),
    strongShared,
    shared: shared + typoShared,
  };
}

/** Overall similarity used for ranking candidates that lack distinctive overlap. */
export function looseSim(a: string, b: string): number {
  return Math.max(jaccard(a, b), typoSim(a, b));
}

export function jaccard(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** Score a candidate against an input, weighting distinctive evidence heavily. */
export function scoreCandidate(input: string, candidate: string): { score: number; dm: DistMatch } {
  const dm = distMatch(input, candidate);
  const score =
    dm.strongShared > 0
      ? Math.min(0.99, SCORE_MIN + dm.ratio * 0.37)
      : dm.shared > 0
        ? dm.ratio * 0.5
        : looseSim(input, candidate) * 0.4;
  return { score, dm };
}

export function isAcceptableMatch(score: number, dm: DistMatch): boolean {
  return dm.strongShared > 0 && dm.ratio >= MATCH_MIN && score >= SCORE_MIN;
}

export { normName };
