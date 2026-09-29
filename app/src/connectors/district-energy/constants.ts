import type { UniverseSource } from '../shared/types.js';

/**
 * Universe sources for District Energy (EXPANSION-PLAN.md §3). These are the
 * SAME HTTP endpoints registered on the sector card in
 * prototype/coldpath-sectors-prototype.html — verified live (HTTP 200) on
 * 2026-09-30. `verifiedAt` is refreshed by scripts/verify-sector-sources.ts;
 * a source that stops answering fails CI rather than silently rotting.
 */
export const DISTRICT_ENERGY_SOURCES: readonly UniverseSource[] = [
  {
    id: 'de-dtc-directory',
    label: 'District Energy in Cities / Drive to Zero city roster',
    url: 'https://heatpumpingtechnologies.org/',
    publisher: 'IEA DHC / ERF',
    licence: 'attribution-required; confirm redistribution terms before storing (G1)',
    vertical: 'district_energy',
    role: 'Connector #1 seed: named city systems + operator contacts (EXPANSION-PLAN §6 step 4)',
    verifiedAt: '2026-09-30',
  },
  {
    id: 'de-aceee-census',
    label: 'ACEEE Census of Community District Energy',
    url: 'https://aceee.org/project/census-community-district-energy',
    publisher: 'ACEEE',
    licence: 'free for research use; cite census edition',
    vertical: 'district_energy',
    role: 'US universe counts by system type/state — denominator for coverage claims',
    verifiedAt: '2026-09-30',
  },
  {
    id: 'de-portfolio-manager',
    label: 'ENERGY STAR Portfolio Manager benchmarking',
    url: 'https://www.energystar.gov/benchmark',
    publisher: 'US EPA',
    licence: 'public-domain tool; per-building data belongs to the building owner',
    vertical: 'district_energy',
    role: 'Campus EUI screen → infer central plant presence (C1 evidence)',
    verifiedAt: '2026-09-30',
  },
  {
    id: 'de-edgar-fulltext',
    label: 'SEC EDGAR full-text search — "district energy"',
    url: 'https://efts.sec.gov/LATEST/search-index?q=%22district+energy%22',
    publisher: 'SEC',
    licence: 'public domain',
    vertical: 'district_energy',
    role: 'Capex/expansion signals in REIT & campus-parent filings (shared edgar kind)',
    verifiedAt: '2026-09-30',
  },
];

/** MW-th -> est_peak_kw conversion placeholder (EXPANSION-PLAN §6 step 1 table). */
export const MW_TH_TO_KW_FACTOR = 1000;
