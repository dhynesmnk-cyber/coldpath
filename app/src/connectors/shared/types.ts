/**
 * Shared connector scaffolding for the expansion verticals
 * (EXPANSION-PLAN.md §6 steps 4-7). The epa-rmp connector is the pattern:
 * typed raw shape -> pure normalise() -> records with mandatory provenance.
 * These types make that contract reusable without dragging cold-chain domain
 * knowledge into new connectors (eslint layer rule: connectors fetch and
 * normalise, nothing else).
 */

/** One row of a parsed universe source, before validation/scoring. */
export interface SectorSiteRecord {
  readonly name: string;
  readonly city: string | null;
  readonly state: string | null;
  readonly naics: string | null;
  /** Free-text industry descriptor - feeds the continuous-process exclusion gate. */
  readonly industry: string | null;
  /** Raw proxy metric in source units (MW-th, clinker tpy, charger kW, MGD...). */
  readonly proxyValue: number;
  readonly proxyUnit: SectorProxyUnit;
  /** Source URL this row was parsed from - provenance is non-nullable (G0). */
  readonly sourceUrl: string;
  readonly licence: string;
  readonly externalId: string | null;
}

export type SectorProxyUnit = 'mw_th' | 'thousand_tonnes_clinker_per_year' | 'kw_charger' | 'mgd';

export interface NormaliseResult {
  readonly records: SectorSiteRecord[];
  /** Rows the parser could not turn into a valid record - routed to review, never dropped. */
  readonly rejected: readonly { raw: unknown; reason: string }[];
}

/**
 * A universe source: the real HTTP connection registered on the sector card in
 * prototype/coldpath-sectors-prototype.html, mirrored here so code and
 * prototype cite the same endpoints. `verifiedAt` is when the URL last returned
 * HTTP 200 from CI/dev (see scripts/verify-sector-sources.ts).
 */
export interface UniverseSource {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly publisher: string;
  readonly licence: string;
  readonly vertical: ExpansionVertical;
  readonly role: string;
  readonly verifiedAt: string;
}

export type ExpansionVertical = 'cement_bulk_minerals' | 'district_energy' | 'heavy_transport_ev_depots';
