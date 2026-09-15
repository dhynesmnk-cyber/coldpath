/**
 * Name normalisation for entity resolution.
 *
 * Ported from phase1/connectors/epa_rmp.py and the prototype resolver. Both are
 * the reference implementation; the parity test in tests/integration asserts this
 * port reproduces them exactly on the real 1,382-facility dataset.
 */

/**
 * Strings that look like names but are not. Reported as a parent company in the
 * real RMP data — two of the four unresolved facilities in the live pull had the
 * literal value "NA".
 */
export const JUNK: ReadonlySet<string> = new Set([
  'na', 'n a', 'n/a', 'unknown', 'none', '-', '', 'test', 'tbd', 'xxx', 'not applicable',
]);

/**
 * Legal-entity suffixes, stripped before any comparison.
 *
 * Exported and shared with canonical.ts rather than duplicated. It used to exist
 * twice, once here and once there with an added `i` flag, and the two copies
 * diverging is precisely how a company acquires two match keys — the defect
 * matchKey's own doc comment describes. One list, one place to edit.
 *
 * Case-insensitive because displayName() runs it against the ORIGINAL casing;
 * normName() and matchKey() lowercase first, where the flag is a harmless no-op.
 */
export const LEGAL_SUFFIXES = /\b(inc|llc|ltd|lp|llp|corp|corporation|company|co|plc|gmbh|sa|nv|bv|the|and)\b/gi;

/** Lowercase, strip punctuation and legal suffixes, collapse whitespace. */
export function normName(input: string | null | undefined): string {
  return (input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9& ]/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Meaningful tokens: length > 1 so single initials and stray punctuation drop out. */
export function tokens(input: string): Set<string> {
  return new Set(normName(input).split(' ').filter((t) => t.length > 1));
}

/** True when the name carries no usable signal. Checked BEFORE any fuzzy match. */
export function isJunkName(input: string | null | undefined): boolean {
  const n = normName(input);
  return n.length === 0 || JUNK.has(n);
}

/**
 * Filter that removes junk WITHOUT removing short acronyms.
 *
 * Measured defect this replaces: an earlier version used a minimum-length rule,
 * which rejected `JDB, Inc.` (BrucePac's reported parent) and `ACS-LLC` as junk.
 * Both are real companies. The correct test is membership in a junk set, not length.
 */
export function isUsableName(input: string | null | undefined): boolean {
  return !isJunkName(input);
}

/** Levenshtein distance. Iterative, O(min(m,n)) memory. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j += 1) {
      const del = (prev[j] ?? 0) + 1;
      const ins = (cur[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur.push(Math.min(del, ins, sub));
    }
    prev = cur;
  }
  return prev[n] ?? Math.max(m, n);
}

/** Similarity 0..1 on whole normalised names. */
export function typoSim(a: string, b: string): number {
  const na = normName(a);
  const nb = normName(b);
  if (na.length === 0 || nb.length === 0) return 0;
  return 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
}

/** Similarity 0..1 on two already-normalised tokens (no re-normalisation). */
export function tokenSim(a: string, b: string): number {
  if (a === b) return 1;
  const m = Math.max(a.length, b.length);
  return m === 0 ? 0 : 1 - levenshtein(a, b) / m;
}
