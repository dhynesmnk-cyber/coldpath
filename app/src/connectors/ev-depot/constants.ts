import type { UniverseSource } from '../shared/types.js';

/** Heavy Transport EV Depot universe sources (EXPANSION-PLAN.md §4) — same HTTP
 *  endpoints as the sector card in prototype/coldpath-sectors-prototype.html,
 *  live-verified (HTTP 200) 2026-09-30. See scripts/verify-sector-sources.ts. */
export const EV_DEPOT_SOURCES: readonly UniverseSource[] = [
  {
    id: 'ev-afdc-datasets',
    label: 'DOE AFDC alternative-fuelling station datasets',
    url: 'https://afdc.energy.gov/data',
    publisher: 'DOE / NREL',
    licence: 'public domain; cite AFDC',
    vertical: 'heavy_transport_ev_depots',
    role: 'Seed registry of charging stations incl. fleet/private sites',
    verifiedAt: '2026-09-30',
  },
  {
    id: 'ev-afdc-locator',
    label: 'AFDC station locator (per-site verification)',
    url: 'https://afdc.energy.gov/stations',
    publisher: 'DOE / NREL',
    licence: 'public domain; cite AFDC',
    vertical: 'heavy_transport_ev_depots',
    role: 'Manual per-site verification pass before scoring',
    verifiedAt: '2026-09-30',
  },
  {
    id: 'ev-grantsgov-awards',
    label: 'Grants.gov awarded projects (Clean School Bus / Diesel Replacement)',
    url: 'https://www.grants.gov/search-results?keyword=electric%20bus%20charging',
    publisher: 'GSA / EPA',
    licence: 'public domain',
    vertical: 'heavy_transport_ev_depots',
    role: 'Named fleets + funded kW — strongest intent signal in the vertical',
    verifiedAt: '2026-09-30',
  },
  {
    id: 'ev-cpuc-dockets',
    label: 'CPUC electrical-energy dockets (utility make-ready programs)',
    url: 'https://www.cpuc.ca.gov/industries-and-topics/electrical-energy',
    publisher: 'CPUC',
    licence: 'public domain',
    vertical: 'heavy_transport_ev_depots',
    role: 'Structured depot-project pipeline in CA territory',
    verifiedAt: '2026-09-30',
  },
];

/** Charger kW is already the peak-kw proxy; factor kept explicit for config parity. */
export const CHARGER_KW_TO_KW_FACTOR = 1;
