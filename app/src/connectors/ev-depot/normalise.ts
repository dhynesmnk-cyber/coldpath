import type { NormaliseResult, SectorSiteRecord } from '../shared/types.js';
import { EV_DEPOT_SOURCES } from './constants.js';

/** Raw row shape of the AFDC stations CSV export (typed subset we depend on). */
export interface AfdcStationRow {
  readonly StationName?: string | null;
  readonly City?: string | null;
  readonly State?: string | null;
  readonly EVConnectionsPowerkW?: string | null;
  readonly AccessCode?: string | null;
  readonly GroupsInEVprivateUse?: string | null;
  readonly SourceURL?: string | null;
}

const SEED = EV_DEPOT_SOURCES.find((s) => s.id === 'ev-afdc-datasets');

/** AFDC power field is semicolon-delimited per connector ("50;150;") or blank. */
export function maxConnectorKw(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const parts = raw.split(';').map((p) => Number.parseFloat(p.trim())).filter((n) => Number.isFinite(n) && n >= 0);
  return parts.length === 0 ? null : Math.max(...parts);
}

/**
 * Pure normalise(). Fleet/private access (AccessCode E/H or private-use groups)
 * is what makes a station a DEPOT candidate rather than public charging noise;
 * everything else is rejected-to-review, never silently dropped.
 */
export function normaliseStations(rows: readonly AfdcStationRow[]): NormaliseResult {
  const records: SectorSiteRecord[] = [];
  const rejected: NormaliseResult['rejected'] = [];

  for (const row of rows) {
    const name = (row.StationName ?? '').trim();
    if (!name) {
      rejected.push({ raw: row, reason: 'G0: station row without a name is refused.' });
      continue;
    }
    const kw = maxConnectorKw(row.EVConnectionsPowerkW);
    if (kw === null) {
      rejected.push({ raw: row, reason: 'no parsable connector kW; routed to review (outlier gate needs a numeric proxy).' });
      continue;
    }
    const isFleet = row.AccessCode === 'E' || row.AccessCode === 'H' || (row.GroupsInEVprivateUse ?? '').trim() !== '';
    if (!isFleet) {
      rejected.push({ raw: row, reason: `access code "${row.AccessCode ?? ''}" looks public-retail; not a depot candidate.` });
      continue;
    }
    records.push({
      name,
      city: (row.City ?? '').trim() || null,
      state: (row.State ?? '').trim().toUpperCase() || null,
      naics: null, // depot sites straddle 488510/829990; left null until the §6-step-1 mapping table lands
      industry: 'electric vehicle depot charging',
      proxyValue: kw,
      proxyUnit: 'kw_charger',
      sourceUrl: (row.SourceURL ?? SEED?.url ?? '').trim(),
      licence: SEED?.licence ?? 'review required (G1)',
      externalId: null,
    });
  }
  return { records, rejected };
}
