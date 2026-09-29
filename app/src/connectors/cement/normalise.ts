import type { NormaliseResult, SectorSiteRecord } from '../shared/types.js';
import { CEMENT_SOURCES } from './constants.js';

/** Raw row shape of the USGS plant-list parse (PDF table -> typed rows). */
export interface CementPlantRow {
  readonly plantName?: string | null;
  readonly company?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly clinkerKtpy?: number | string | null;
  readonly sourceUrl?: string | null;
}

const SOURCE = CEMENT_SOURCES.find((s) => s.id === 'cem-usgs-plants');

function toKtpy(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number.parseFloat(v.replace(/,/g, '')) : v;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Pure normalise(): G0 provenance enforcement, rejects routed not dropped. */
export function normalisePlants(rows: readonly CementPlantRow[]): NormaliseResult {
  const records: SectorSiteRecord[] = [];
  const rejected: NormaliseResult['rejected'] = [];

  for (const row of rows) {
    const name = (row.plantName ?? '').trim();
    if (!name) {
      rejected.push({ raw: row, reason: 'G0: plant row without a name is refused.' });
      continue;
    }
    const ktpy = toKtpy(row.clinkerKtpy);
    if (ktpy === null) {
      rejected.push({ raw: row, reason: `clinker_ktpy "${String(row.clinkerKtpy)}" is not a non-negative number; routed to review.` });
      continue;
    }
    records.push({
      name,
      city: (row.city ?? '').trim() || null,
      state: (row.state ?? '').trim().toUpperCase() || null,
      naics: '327311', // cement mills — deliberately lands on the continuous-process exclusion rule X1-naics
      industry: `${(row.company ?? 'cement').trim()} cement production`,
      proxyValue: ktpy,
      proxyUnit: 'thousand_tonnes_clinker_per_year',
      sourceUrl: (row.sourceUrl ?? SOURCE?.url ?? '').trim(),
      licence: SOURCE?.licence ?? 'review required (G1)',
      externalId: null,
    });
  }
  return { records, rejected };
}
