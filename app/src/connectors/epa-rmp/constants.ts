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

/** Pilot filter: single-site operators below this charge are not enterprise prospects. */
export const SINGLE_SITE_AMMONIA_FLOOR = 250_000;
