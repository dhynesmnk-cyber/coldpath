/**
 * Continuous-process exclusion gate — EXPANSION-PLAN.md §6 step 3.
 *
 * The cold-chain thesis rests on load shedding: a refrigeration compressor can
 * throttle without spoiling product, so a demand-charge conversation has a real
 * buying window. A continuous-process plant (glass furnace, steel EAF, paper
 * machine, chemicals-once-through) cannot shut down on spot-price signals at
 * all; scoring it with sheddability-weighted ICP models produces confident
 * nonsense.
 *
 * So the gate runs BEFORE scoring. It is a pure function — no I/O, per the
 * layer rules in eslint.config.js — and its blocking behaviour mirrors C5:
 * a refused record is never dropped. It is routed to the review queue with a
 * reason, exactly like an unresolved parent name or a numeric outlier.
 *
 * The industry list below is a DRAFT pending Ndustrial's policy sign-off
 * (EXPANSION-PLAN.md §7 need #2: "who counts as 'cannot shut down' needs a
 * domain expert, not a guess"). Adding an NAICS prefix here is config, not
 * code — but every addition must come with a fixture in the acceptance test.
 */

export interface ExclusionCandidate {
  /** 2–6 digit NAICS code as reported by the source. Empty/absent = unknown. */
  readonly naics?: string | null;
  /** Free-text industry descriptor from the connector, matched against keywords. */
  readonly industry?: string | null;
}

export type ExclusionDecision = 'pass' | 'review';

export interface ExclusionResult {
  readonly decision: ExclusionDecision;
  /** True when the record must NOT be scored or exported. */
  readonly excluded: boolean;
  readonly ruleId: string;
  readonly reason: string;
}

/** NAICS families that are continuous-process by nature (draft, see header). */
const CONTINUOUS_NAICS: ReadonlyMap<string, string> = new Map([
  ['3272', 'Flat glass manufacturing'],
  ['3273', 'Cement & concrete product manufacturing'], // kilns: 24/7, reline-gated
  ['3311', 'Iron & steel mills & foundries'],
  ['3312', 'Steel product manufacturing from purchased steel'],
  ['3212', 'Wood pulp & paper/paperboard mills'],
  ['3221', 'Pulp, paper & paperboard mills'],
  ['3251', 'Industrial gas & basic chemical manufacturing (once-through)'],
]);

/**
 * Keyword fallback for sources without reliable NAICS (news, master plans).
 * Deliberately narrow: near-misses go to review, they do not auto-exclude.
 */
const CONTINUOUS_KEYWORDS: readonly (readonly [string, string])[] = [
  ['glass furnace', 'float-glass furnace run'],
  ['blast furnace', 'iron blast furnace run'],
  ['paper machine', 'continuous paper mill run'],
  ['petroleum refinery', 'refinery process units'],
  ['chlor-alkali', 'electrochemical once-through process'],
];

function trimmedNaics(naics: string | null | undefined): string {
  return (naics ?? '').trim().replace(/[^0-9]/g, '');
}

/** Pure decision function. Same input always yields the same verdict. */
export function continuousProcessExclusion(c: ExclusionCandidate): ExclusionResult {
  const digits = trimmedNaics(c.naics);
  const industry = (c.industry ?? '').toLowerCase();

  if (digits.length >= 4 && CONTINUOUS_NAICS.has(digits.slice(0, 4))) {
    const label = CONTINUOUS_NAICS.get(digits.slice(0, 4))!;
    return {
      decision: 'review', excluded: true, ruleId: 'X1-naics',
      reason: `Continuous-process industry (${label}, NAICS ${digits.slice(0, 4)}): load shedding not credible. Routed to review, never scored.`,
    };
  }
  for (const [needle, label] of CONTINUOUS_KEYWORDS) {
    if (industry.includes(needle)) {
      return {
        decision: 'review', excluded: true, ruleId: 'X1-keyword',
        reason: `Industry text matches continuous-process signature ("${label}"). Routed to review, never scored.`,
      };
    }
  }
  return { decision: 'pass', excluded: false, ruleId: 'X0', reason: '' };
}

/**
 * Gate entry point mirroring the C5 structure: refuse-with-reason, route to
 * review, never silently drop. Returns the candidate annotated with the
 * verdict so callers keep their records intact.
 */
export function applyExclusionGate<T extends ExclusionCandidate>(record: T): T & ExclusionResult {
  return { ...record, ...continuousProcessExclusion(record) };
}
