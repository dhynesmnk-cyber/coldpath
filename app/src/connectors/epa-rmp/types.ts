/** Raw shape of an EPA RMP facility record, as served by the registry API. */
export interface RmpChemical {
  readonly id?: number | null;
  readonly name?: string | null;
  readonly qty?: number | null;
}

export interface RmpFacility {
  readonly facilityId: string;
  readonly facilityName?: string | null;
  readonly address?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly zipcode?: string | null;
  readonly facilityLat?: string | null;
  readonly facilityLong?: string | null;
  readonly parentCompanyName?: string | null;
  readonly operatorName?: string | null;
  readonly facilityURL?: string | null;
  readonly noAccidents?: string | null;
  readonly isDeregistered?: boolean | null;
  readonly naicsCode?: string | null;
  readonly programLevel?: number | null;
  readonly allAccidentsCount?: number | null;
  readonly recentAccidentsCount?: number | null;
  readonly submissionsCount?: number | null;
  /** Compact chemical list produced by the fixture extractor. */
  readonly _chem?: readonly RmpChemical[] | null;
  /** Shape used by the live API. */
  readonly chemicals?: readonly { chemicalId?: number; chemicalName?: string; quantity?: number }[] | null;
}

export interface SiteRecord {
  name: string;
  city: string;
  state: string;
  naics: string;
  ammoniaLb: number;
  programLevel: number | null;
  accidents: number;
  recentAccidents: number;
  submissions: number;
  rmpId: string;
  url: string;
  lat: string | null;
  lon: string | null;
  validated: boolean;
  validationNote: string;
  account?: string;
}

export type Rto =
  | 'PJM' | 'MISO' | 'SPP' | 'ERCOT' | 'NYISO' | 'ISO-NE' | 'CAISO' | 'WECC'
  | 'SERC' | 'TVA' | 'Duke' | 'NW' | 'SWPP' | 'Other';

export interface AccountRecord {
  account: string;
  isCustomer: boolean;
  aliases: string[];
  sites: number;
  ammoniaLb: number;
  maxSiteAmmoniaLb: number;
  unvalidatedSites: number;
  states: number;
  stateList: string;
  primaryRto: Rto;
  accidents: number;
  sitesWithAccidents: number;
  primaryNaics: string;
  vertical: string;
  rank: number;
  icp: { score: number; components: Record<string, number> };
  _sites: SiteRecord[];
}

export interface ReviewRecord {
  /**
   * numeric_outlier   a reported value failed the plausibility gate
   * unresolved_name   no usable company name after normalisation
   * below_threshold   resolved, but under the pilot floor and worth a look
   * merge_rescue      a pattern guard stopped this being absorbed into another
   *                   account — the reviewer confirms they are separate
   * operator_is_person the operator field held an individual, so the company
   *                   was taken from the facility name instead
   */
  kind: 'numeric_outlier' | 'unresolved_name' | 'below_threshold' | 'merge_rescue' | 'operator_is_person';
  rmpId: string;
  name: string;
  city: string;
  state: string;
  naics: string;
  ammoniaLb: number;
  reportedName: string;
  account: string;
  reason: string;
  validationNote: string;
  action: string;
}

export interface AggregateResult {
  accounts: AccountRecord[];
  sites: SiteRecord[];
  reviewQueue: ReviewRecord[];
  unresolved: ReviewRecord[];
  stats: { facilitiesIn: number; active: number; p99: number; median: number; ceiling: number; flagged: number };
}
