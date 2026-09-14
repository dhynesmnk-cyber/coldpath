/**
 * Numeric validation gate — INGESTION-GATES.md §7.2.
 *
 * MEASURED NECESSITY. In the live EPA RMP pull one facility ("Neches Terminal",
 * Beaumont TX, reported under "Martin Operating Partnership") declares
 * 89,000,000 lb of anhydrous ammonia. Across 755 sites the median is 20,023 lb
 * and p99 is 180,000 lb; the largest legitimate single charge is 715,862 lb.
 *
 * That one record is 494x the p99, 124x the largest legitimate charge, and 78% of
 * ALL ammonia reported in the entire
 * dataset. The facility is a marine terminal, not a cold store. Left unvalidated
 * it scored 60 on the ICP model and ranked #15 of 111 prospects — above Hormel,
 * Schwan's and Cargill.
 *
 * Self-reported regulatory data contains units errors and NAICS misclassifications.
 * Flagged records are retained and surfaced for human review, never dropped:
 * discarding the loudest data-quality signal in the dataset would be worse than
 * the outlier itself.
 */

/** A value this many times the p99 is treated as implausible. */
export const OUTLIER_FACTOR = 10;

export function percentile(values: readonly number[], pct: number): number {
  const positive = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (positive.length === 0) return 0;
  const idx = Math.min(positive.length - 1, Math.floor(positive.length * pct));
  return positive[idx] ?? 0;
}

export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

export interface ValidatedRecord<T> {
  readonly record: T;
  readonly validated: boolean;
  readonly validationNote: string;
}

export interface OutlierStats {
  readonly p99: number;
  readonly median: number;
  readonly ceiling: number;
  readonly flagged: number;
}

/**
 * Flag statistically implausible numeric fields.
 *
 * A flagged record keeps its data (so a human can inspect and correct it) but is
 * excluded from account-level aggregation and from ICP scoring.
 */
export function validateNumericField<T>(
  records: readonly T[],
  extract: (r: T) => number,
  fieldName: string,
  factor: number = OUTLIER_FACTOR,
): { results: ValidatedRecord<T>[]; stats: OutlierStats } {
  const values = records.map(extract);
  const p99 = percentile(values, 0.99);
  const med = median(values);
  const ceiling = p99 * factor;

  const results = records.map((record) => {
    const value = extract(record);
    if (value > ceiling && ceiling > 0) {
      return {
        record,
        validated: false,
        validationNote:
          `${fieldName} ${value.toLocaleString('en-US')} exceeds p99 (${Math.round(p99).toLocaleString('en-US')}) x ${factor}; ` +
          `median is ${Math.round(med).toLocaleString('en-US')}. Probable units error or NAICS ` +
          `misclassification in the self-reported filing. Excluded from scoring pending human review.`,
      };
    }
    return { record, validated: true, validationNote: '' };
  });

  return { results, stats: { p99, median: med, ceiling, flagged: results.filter((r) => !r.validated).length } };
}
