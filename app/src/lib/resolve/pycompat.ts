/**
 * Compatibility shims for porting the Python reference implementation.
 *
 * These exist because two behaviours differ silently between Python and
 * JavaScript, and either one would make the parity test fail intermittently on
 * data that happens to hit the boundary:
 *
 *   1. Python's round() is banker's rounding (half-to-even). Math.round() is
 *      half-up. round(2.5) == 2 in Python, 3 in JavaScript. This matters for the
 *      ICP refrigeration-intensity component, which divides ammonia by 40,000 —
 *      any account whose total is an exact odd multiple of 20,000 would diverge.
 *
 *   2. collections.Counter.most_common(1) breaks ties by insertion order.
 *      A naive "max by count" in JS may return a different element when two
 *      states or NAICS codes tie, changing primary_rto and therefore the
 *      grid_exposure component of the score.
 */

/** Python's round(): half-to-even. */
export function pyRound(value: number): number {
  if (!Number.isFinite(value)) return value;
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  // exactly .5 -> round to even
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Most frequent value, breaking ties by first-insertion order — matching
 * collections.Counter.most_common(n)[0].
 */
export function modeByInsertion<T>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = -1;
  for (const [value, count] of counts) {
    // Strict > keeps the FIRST inserted on ties, as Counter does.
    if (count > bestCount) { best = value; bestCount = count; }
  }
  return best;
}

/** Python's sorted() on strings: Unicode code-point order. */
export function pySorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
