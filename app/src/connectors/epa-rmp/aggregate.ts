import { canonicaliseParent, KNOWN_CUSTOMERS } from '../../lib/resolve/canonical.js';
import { validateNumericField } from '../../lib/validation/outliers.js';
import { modeByInsertion, pyRound, pySorted } from '../../lib/resolve/pycompat.js';
import { AMMONIA_IDS, NAICS_IN_SCOPE, RTO_BY_STATE, SINGLE_SITE_AMMONIA_FLOOR } from './constants.js';
import type { AccountRecord, AggregateResult, ReviewRecord, RmpFacility, SiteRecord } from './types.js';

/**
 * Faithful TypeScript port of aggregate() and icp_score() in
 * phase1/connectors/epa_rmp.py. The Python module is the reference; the parity
 * test in tests/integration/connector-parity.test.ts diffs this output against
 * the committed CSV on the real 1,382-facility dataset.
 *
 * Where the reference has a quirk, the quirk is reproduced and commented rather
 * than silently "improved" — a port that diverges from its reference cannot be
 * verified, and unverifiable is worse than slightly wrong.
 */

/** Largest single anhydrous-ammonia charge reported at the facility, in pounds. */
export function maxAmmoniaLb(facility: RmpFacility): number {
  const compact = facility._chem ?? [];
  const live = facility.chemicals ?? [];
  const charges: number[] = [];
  for (const c of compact) {
    const isAmmonia = (c.id !== null && c.id !== undefined && AMMONIA_IDS.has(c.id)) || (c.name ?? '').includes('mmonia');
    if (isAmmonia) charges.push(c.qty ?? 0);
  }
  for (const c of live) {
    const isAmmonia = (c.chemicalId !== undefined && AMMONIA_IDS.has(c.chemicalId)) || (c.chemicalName ?? '').includes('mmonia');
    if (isAmmonia) charges.push(c.quantity ?? 0);
  }
  return charges.length === 0 ? 0 : Math.max(...charges);
}

export function icpScore(a: Pick<AccountRecord, 'sites' | 'ammoniaLb' | 'states' | 'primaryRto' | 'sitesWithAccidents' | 'primaryNaics'>): { score: number; components: Record<string, number> } {
  const components: Record<string, number> = {
    scale: Math.min(20, a.sites * 2),
    // pyRound, not Math.round — Python's round() is half-to-even. See pycompat.ts.
    refrig_intensity: Math.min(25, pyRound(a.ammoniaLb / 40_000)),
    geographic_spread: Math.min(15, a.states * 2),
    grid_exposure:
      a.primaryRto === 'PJM' || a.primaryRto === 'ERCOT' || a.primaryRto === 'ISO-NE' ? 14
        : a.primaryRto === 'MISO' || a.primaryRto === 'NYISO' || a.primaryRto === 'CAISO' ? 10
          : 6,
    replacement_signal: Math.min(12, a.sitesWithAccidents * 3),
    vertical_fit: a.primaryNaics === '49312' ? 14 : 9,
  };
  const total = Object.values(components).reduce((x, y) => x + y, 0);
  return { score: Math.min(100, total), components };
}

export function aggregate(facilities: readonly RmpFacility[]): AggregateResult {
  // Buckets are keyed by matchKey (case-folded, punctuation-stripped) so that a
  // company reported under several capitalisations lands in ONE bucket. The
  // display name is taken from the canonical rule when one matched, otherwise from
  // the first reported name seen.
  const buckets = new Map<string, { sites: SiteRecord[]; aliases: Set<string>; name: string; byRule: boolean }>();
  const unresolved: ReviewRecord[] = [];

  // Python's `a or b or c` falls through on empty string; `??` does not. Use an
  // explicit falsy chain so an empty parentCompanyName does not become an account.
  const pick = (...vals: (string | null | undefined)[]): string | null => {
    for (const v of vals) if (typeof v === 'string' && v.trim().length > 0) return v;
    return null;
  };

  let active = 0;
  for (const f of facilities) {
    if (f.isDeregistered === true) continue; // closed plants are not prospects
    active += 1;
    const reported = pick(f.parentCompanyName, f.operatorName, f.facilityName);
    const resolved = canonicaliseParent(reported);
    if (resolved === null) {
      unresolved.push({
        kind: 'unresolved_name',
        rmpId: f.facilityId,
        name: f.facilityName ?? '',
        city: f.city ?? '',
        state: f.state ?? '',
        naics: f.naicsCode ?? '',
        ammoniaLb: maxAmmoniaLb(f),
        reportedName: reported ?? '',
        account: '',
        reason: 'no usable parent/operator/facility name after normalisation',
        validationNote: '',
        action: 'assign to an account or create one',
      });
      continue;
    }
    let bucket = buckets.get(resolved.key);
    if (bucket === undefined) {
      bucket = { sites: [], aliases: new Set(), name: resolved.name, byRule: resolved.by === 'rule' };
      buckets.set(resolved.key, bucket);
    } else if (resolved.by === 'rule' && !bucket.byRule) {
      // A canonical rule outranks a fallback display name.
      bucket.name = resolved.name;
      bucket.byRule = true;
    }
    if (reported !== null) bucket.aliases.add(reported);
    bucket.sites.push({
      name: f.facilityName ?? '', city: f.city ?? '', state: f.state ?? '',
      naics: f.naicsCode ?? '', ammoniaLb: maxAmmoniaLb(f),
      programLevel: f.programLevel ?? null, accidents: f.allAccidentsCount ?? 0,
      recentAccidents: f.recentAccidentsCount ?? 0, submissions: f.submissionsCount ?? 0,
      rmpId: f.facilityId, url: f.facilityURL ?? '',
      lat: f.facilityLat ?? null, lon: f.facilityLong ?? null,
      validated: true, validationNote: '',
    });
  }

  // Numeric validation runs across EVERY bucketed site before aggregation, so a
  // filtered-out account's outlier still lands in the review queue.
  const allSites = [...buckets.values()].flatMap((b) => b.sites);
  const { results, stats } = validateNumericField(allSites, (s) => s.ammoniaLb, 'ammonia_lb');
  for (const r of results) { r.record.validated = r.validated; r.record.validationNote = r.validationNote; }

  const accounts: AccountRecord[] = [];
  for (const [, b] of buckets) {
    const name = b.name;
    const sites = b.sites;
    const scoredSites = sites.filter((s) => s.validated);
    const largest = scoredSites.reduce((m, s) => Math.max(m, s.ammoniaLb), 0);
    // Pilot filter: multi-site operators, or single sites large enough to justify
    // an enterprise motion. Uses SCORED sites, so an account whose only site was
    // flagged as an outlier drops out entirely.
    if (scoredSites.length < 2 && largest < SINGLE_SITE_AMMONIA_FLOOR) continue;

    const primaryRto = (modeByInsertion(sites.map((s) => RTO_BY_STATE[s.state] ?? 'Other')) ?? 'Other');
    const primaryNaics = modeByInsertion(sites.map((s) => s.naics)) ?? '';
    const stateSet = new Set(sites.map((s) => s.state));

    accounts.push({
      account: name,
      isCustomer: KNOWN_CUSTOMERS.has(name),
      aliases: pySorted(b.aliases),
      sites: sites.length,                       // reference counts ALL sites, not just scored
      ammoniaLb: scoredSites.reduce((t, s) => t + s.ammoniaLb, 0),
      maxSiteAmmoniaLb: largest,
      unvalidatedSites: sites.length - scoredSites.length,
      states: stateSet.size,
      stateList: pySorted(stateSet).join(','),
      primaryRto,
      accidents: sites.reduce((t, s) => t + s.accidents, 0),
      sitesWithAccidents: scoredSites.filter((s) => s.accidents > 0).length,
      primaryNaics,
      vertical: NAICS_IN_SCOPE[primaryNaics] ?? 'Other',
      rank: 0,
      icp: { score: 0, components: {} },
      _sites: sites,
    });
  }

  // Reference sort: most sites first, then most ammonia. Stable in both languages.
  accounts.sort((a, b) => b.sites - a.sites || b.ammoniaLb - a.ammoniaLb);
  accounts.forEach((a, i) => {
    a.rank = i + 1;
    a.icp = icpScore(a);
    for (const s of a._sites) s.account = a.account;
  });

  const surviving = new Set<SiteRecord>(accounts.flatMap((a) => a._sites));
  // QUIRK REPRODUCED DELIBERATELY: the reference only queues flagged sites that
  // are NOT part of a surviving account. A flagged site belonging to a surviving
  // account is excluded from scoring but does not appear in the review queue.
  // That is a real gap — noted for a joint fix in both implementations, not
  // silently corrected here, because a port that diverges cannot be verified.
  const flagged: ReviewRecord[] = [];
  for (const [, b] of buckets) {
    const name = b.name;
    for (const s of b.sites) {
      if (s.validated || surviving.has(s)) continue;
      flagged.push({
        kind: 'numeric_outlier', rmpId: s.rmpId, name: s.name, city: s.city, state: s.state,
        naics: s.naics, ammoniaLb: s.ammoniaLb, reportedName: name, account: name,
        reason: s.validationNote, validationNote: s.validationNote,
        action: 'verify the filing, correct the value, or confirm exclusion',
      });
    }
  }

  const sites = accounts.flatMap((a) => a._sites.map((s) => ({ ...s, account: a.account })));
  return {
    accounts,
    sites,
    reviewQueue: [...flagged, ...unresolved],
    unresolved,
    stats: { facilitiesIn: facilities.length, active, ...stats },
  };
}
