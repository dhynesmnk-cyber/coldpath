import type { Rto } from './types.js';

/**
 * NAICS codes defining the cold-chain addressable market.
 * Keys are the 5-digit prefixes the RMP dataset uses.
 * Ported verbatim from phase1/connectors/epa_rmp.py.
 */
export const NAICS_IN_SCOPE: Readonly<Record<string, string>> = {
  '49312': 'Refrigerated warehousing & storage',
  '31161': 'Animal slaughtering & processing',
  '31151': 'Dairy product manufacturing',
  '31141': 'Frozen fruit & vegetable manufacturing',
  '31142': 'Frozen specialty food manufacturing',
  '31199': 'All other food manufacturing',
  '42441': 'Grocery & related product merchant wholesalers',
  '42449': 'Other grocery & related products wholesalers',
  '44511': 'Supermarkets & other grocery retailers',
};

/** Anhydrous ammonia is chemicalId 56 in this dataset. Confirmed by sampling. */
export const AMMONIA_IDS: ReadonlySet<number> = new Set([56]);

/**
 * ISO / RTO / balancing authority by state. Drives the grid-exposure ICP
 * criterion, because capacity-price volatility is where the commercial value is.
 */
export const RTO_BY_STATE: Readonly<Record<string, Rto>> = {
  PA: 'PJM', NJ: 'PJM', MD: 'PJM', DE: 'PJM', VA: 'PJM', WV: 'PJM', OH: 'PJM', IL: 'PJM',
  IN: 'MISO', MI: 'MISO', WI: 'MISO', MN: 'MISO', MO: 'MISO', IA: 'MISO', LA: 'MISO', ND: 'MISO',
  AR: 'SPP', OK: 'SPP', KS: 'SPP', NE: 'SPP', SD: 'SPP',
  TX: 'ERCOT', NY: 'NYISO', NC: 'Duke', SC: 'Duke',
  GA: 'SERC', FL: 'SERC', AL: 'SERC', MS: 'SERC', TN: 'TVA', KY: 'TVA',
  CA: 'CAISO', OR: 'NW', WA: 'NW', ID: 'NW', MT: 'NW',
  CO: 'WECC', UT: 'WECC', NV: 'WECC', AZ: 'WECC', NM: 'WECC',
  CT: 'ISO-NE', MA: 'ISO-NE', NH: 'ISO-NE', VT: 'ISO-NE', RI: 'ISO-NE', ME: 'ISO-NE',
};

/**
 * Pilot filter: single-site operators below this charge are not auto-admitted.
 *
 * Was 250,000, which admitted exactly THREE single-site companies out of 357 —
 * in practice "multi-site only" rather than a floor. It was also concealing
 * genuine prospects whose single in-scope RMP filing understates the business:
 * Smithfield Fresh Meats, Charoen Pokphand Foods and Mitsubishi all sit between
 * 80,000 and 110,000 lb.
 *
 * At 100,000 the auto-admitted set stays clean. Below it the data quality drops
 * sharply — operator names that are actually individuals, facility codes, and a
 * duplicate Perdue — which is why the 50,000–100,000 band is QUEUED for a human
 * rather than admitted. See SUBTHRESHOLD_QUEUE_FLOOR.
 */
export const SINGLE_SITE_AMMONIA_FLOOR = 100_000;

/**
 * Sub-threshold review floor — INGESTION-GATES.md §1, gate G9.
 *
 * A company that resolves cleanly but falls below the pilot filter is dropped.
 * Silently, and 354 times over on the current pull, which makes "nothing is
 * silently dropped" untrue for the largest category of refusal in the system.
 *
 * Companies above this charge but below the pilot floor are queued instead:
 * roughly 29 on the current pull, a number a person can actually read. Lower
 * floors do not help — the EPA reporting threshold is 10,000 lb, so the dropped
 * set is dense at the bottom and a 25,000 floor would queue 120.
 */
export const SUBTHRESHOLD_QUEUE_FLOOR = 50_000;
