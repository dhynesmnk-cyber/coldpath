import type { NormaliseResult, SectorSiteRecord } from '../shared/types.js';
import { DISTRICT_ENERGY_SOURCES } from './constants.js';

/** Raw row shape as the DTC/ACEEE directory parse will serve it. */
export interface DirectoryRow {
  readonly systemName?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly systemType?: string | null;
  readonly capacityMwTh?: number | string | null;
  readonly sourceUrl?: string | null;
}

const SOURCE = DISTRICT_ENERGY_SOURCES.find((s) => s.id === 'de-dtc-directory');

function toMwTh(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number.parseFloat(v.replace(/,/g, '')) : v;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Pure normalise() following the epa-rmp pattern: typed raw rows in,
 * provenance-complete records out, unparseable rows routed to `rejected`
 * (never dropped). G0: a row with no name or no source URL cannot be stored.
 */
export function normaliseDirectory(rows: readonly DirectoryRow[]): NormaliseResult {
  const records: SectorSiteRecord[] = [];
  const rejected: NormaliseResult['rejected'] = [];

  for (const row of rows) {
    const name = (row.systemName ?? '').trim();
    if (!name) {
      rejected.push({ raw: row, reason: 'G0: missing system name — record without identity is refused, not stored blank.' });
      continue;
    }
    const sourceUrl = (row.sourceUrl ?? SOURCE?.url ?? '').trim();
    if (!sourceUrl) {
      rejected.push({ raw: row, reason: 'G0: no source URL — provenance is non-nullable.' });
      continue;
    }
    const mwTh = toMwTh(row.capacityMwTh);
    if (mwTh === null) {
      rejected.push({ raw: row, reason: `capacity_mw_th "${String(row.capacityMwTh)}" is not a non-negative number; routed to review.` });
      continue;
    }
    records.push({
      name,
      city: (row.city ?? '').trim() || null,
      state: (row.state ?? '').trim().toUpperCase() || null,
      naics: '221310', // water/district-style utility NAICS stays null until mapped; keep explicit
      industry: (row.systemType ?? 'district energy').trim() || 'district energy',
      proxyValue: mwTh,
      proxyUnit: 'mw_th',
      sourceUrl,
      licence: SOURCE?.licence ?? 'review required (G1)',
      externalId: null,
    });
  }
  return { records, rejected };
}
