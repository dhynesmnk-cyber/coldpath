import type { UniverseSource } from '../shared/types.js';

/** Cement & Bulk Minerals universe sources (EXPANSION-PLAN.md §2) — same HTTP
 *  endpoints as the sector card in prototype/coldpath-sectors-prototype.html,
 *  live-verified (HTTP 200) 2026-09-30. See scripts/verify-sector-sources.ts. */
export const CEMENT_SOURCES: readonly UniverseSource[] = [
  {
    id: 'cem-usgs-plants',
    label: 'USGS 2025 Minerals Yearbook — cement plants & kilns',
    url: 'https://pubs.usgs.gov/periodicals/mcs2025/mcs2025-cement.pdf',
    publisher: 'USGS',
    licence: 'public domain',
    vertical: 'cement_bulk_minerals',
    role: 'Primary census seed: plant locations, capacity, parent company',
    verifiedAt: '2026-09-30',
  },
  {
    id: 'cem-eia-mecs',
    label: 'EIA Manufacturing Energy Consumption Survey',
    url: 'https://www.eia.gov/consumption/manufacturing/',
    publisher: 'EIA',
    licence: 'public domain',
    vertical: 'cement_bulk_minerals',
    role: 'Energy intensity calibration for clinker-tonnes -> est_peak_kw',
    verifiedAt: '2026-09-30',
  },
  {
    id: 'cem-edgar-fulltext',
    label: 'SEC EDGAR full-text search — "grinding mill"',
    url: 'https://efts.sec.gov/LATEST/search-index?q=%22grinding+mill%22&forms=8-K',
    publisher: 'SEC',
    licence: 'public domain',
    vertical: 'cement_bulk_minerals',
    role: 'Capex/expansion signals via 8-K filings (shared edgar kind)',
    verifiedAt: '2026-09-30',
  },
  {
    id: 'cem-ftc-premerger',
    label: 'FTC premerger notification program',
    url: 'https://www.ftc.gov/policy',
    publisher: 'FTC',
    licence: 'public domain; second-request data restricted',
    vertical: 'cement_bulk_minerals',
    role: 'M&A trigger stream: ready-mix/aggregates acquisitions (new-target-account-triggers)',
    verifiedAt: '2026-09-30',
  },
];

/** Thousand tonnes clinker/yr -> est_peak_kw placeholder (§6 step 1 table). */
export const CLINKER_KTPY_TO_KW_FACTOR = 0.15;
