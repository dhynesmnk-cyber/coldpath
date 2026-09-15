import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aggregate, maxAmmoniaLb } from '@/connectors/epa-rmp/aggregate.js';
import { canonicalName, KNOWN_CUSTOMERS, mergeRescue } from '@/lib/resolve/canonical.js';
import { parseCsvObjects } from '@/lib/csv.js';
import type { RmpFacility } from '@/connectors/epa-rmp/types.js';

/**
 * PARITY TEST — PRODUCT-PLAN.md §10 risk #3.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT.
 *
 * This file runs the TypeScript port against the committed fixture and diffs
 * every field of every account against the committed reference CSVs. That is
 * one leg of the proof:
 *
 *     leg 1 (here)  TypeScript(fixture) == committed CSV
 *     leg 2 (CI)    committed CSV       == Python(fixture)
 *
 * Only together do they give TypeScript == Python, which is what "parity"
 * claims. This file deliberately does NOT execute the Python: its value is that
 * it needs no database and no toolchain, and a test that skips itself when
 * python3 is absent would be a check that cannot fail.
 *
 * Leg 2 is `python3 phase1/connectors/regen_reference.py --check`, run in CI.
 * Without it the Python could drift from its own committed output invisibly —
 * which already happened once: max_ammonia_lb() read only the live API's
 * chemical shape, so every facility in the fixture reported 0 lb and two
 * accounts silently vanished. Nothing failed.
 *
 * The port is not done until this passes. No database is required — it reads two
 * fixtures — so it runs under vitest in any environment.
 */
const dir = fileURLToPath(new URL('../fixtures', import.meta.url));
const read = (f: string): string => readFileSync(`${dir}/${f}`, 'utf8');

const fixture = JSON.parse(read('rmp-facilities.json')) as {
  meta: { count: number; pulled: string; licence: string };
  facilities: RmpFacility[];
};

// Quoted-field-aware. state_list and aliases both contain commas, so a naive
// split silently shifts every column after them — which is exactly how the first
// version of this test produced 257 phantom field diffs.
const parseCsv = (text: string): Record<string, string>[] => parseCsvObjects(text);

const expected = parseCsv(read('coldchain_rmp_accounts.csv'));
const expectedQueue = parseCsv(read('coldchain_rmp_review_queue.csv'));
const actual = aggregate(fixture.facilities);
const byName = new Map(actual.accounts.map((a) => [a.account, a]));

describe('fixture integrity', () => {
  it('loads the full live RMP pull', () => {
    expect(fixture.facilities.length).toBe(1382);
    expect(fixture.meta.count).toBe(1382);
    expect(fixture.meta.licence).toBe('CC BY-SA 4.0');
  });

  /**
   * The fixture is the SHARED INPUT to both implementations, which is exactly
   * why counts alone do not protect it: edit a value in place and both sides
   * move together, so every parity assertion still passes while the reference
   * quietly stops corresponding to the documented 13 September 2026 EPA pull.
   *
   * A checksum is the only assertion here that an in-place edit cannot satisfy.
   * If this fails because you deliberately re-pulled from EPA, update the hash
   * in the same commit as the new fixture and regenerate the reference CSVs.
   */
  it('is the exact 13 September 2026 pull, byte for byte', () => {
    const bytes = readFileSync(`${dir}/rmp-facilities.json`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(digest).toBe('967979bb5af6c323facf2f98c98bcae29d5646fad820d58eaf36d9035f2ce65f');
    expect(fixture.meta.pulled).toBe('2026-09-13');
  });
  it('has a committed Python reference to compare against', () => {
    // 117 -> 122: the pilot floor dropped 250,000 -> 100,000, admitting four
    // single-site companies (Harkins Street Holdings, DPF Holdings, Super Store
    // Industries, Charoen Pokphand Foods); and Perdue Farms stopped being two
    // accounts, which gave it two sites and so cleared the filter on count.
    expect(expected.length).toBe(122);
  });
});

describe('aggregate() reproduces the Python reference exactly', () => {
  it('produces the same number of accounts', () => {
    expect(actual.accounts.length).toBe(expected.length);
  });

  it('produces the same accounts in the same rank order', () => {
    expect(actual.accounts.map((a) => a.account)).toEqual(expected.map((r) => r.account));
  });

  it('matches every scalar field on every account', () => {
    const diffs: string[] = [];
    for (const row of expected) {
      const a = byName.get(row.account ?? '');
      if (a === undefined) { diffs.push(`MISSING account ${row.account}`); continue; }
      const checks: [string, string, string][] = [
        ['rank', String(a.rank), row.rank ?? ''],
        ['icp_score', String(a.icp.score), row.icp_score ?? ''],
        // The Python reference writes Python bool repr ("True"/"False").
        ['is_customer', String(a.isCustomer), String(row.is_customer === 'True')],
        ['sites', String(a.sites), row.sites ?? ''],
        ['unvalidated_sites', String(a.unvalidatedSites), row.unvalidated_sites ?? ''],
        ['ammonia_lb', String(a.ammoniaLb), row.ammonia_lb ?? ''],
        ['max_site_ammonia_lb', String(a.maxSiteAmmoniaLb), row.max_site_ammonia_lb ?? ''],
        ['states', String(a.states), row.states ?? ''],
        ['state_list', a.stateList, row.state_list ?? ''],
        ['primary_rto', a.primaryRto, row.primary_rto ?? ''],
        ['accidents', String(a.accidents), row.accidents ?? ''],
        ['sites_with_accidents', String(a.sitesWithAccidents), row.sites_with_accidents ?? ''],
        ['primary_naics', a.primaryNaics, row.primary_naics ?? ''],
        ['vertical', a.vertical, row.vertical ?? ''],
        ['aliases', a.aliases.join(' | '), row.aliases ?? ''],
      ];
      for (const [field, got, want] of checks) {
        if (got !== want) diffs.push(`${row.account}.${field}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
      }
    }
    expect(diffs, diffs.slice(0, 12).join('\n  ')).toEqual([]);
  });

  it('matches the site total', () => {
    const want = expected.reduce((t, r) => t + Number(r.sites ?? 0), 0);
    expect(actual.sites.length).toBe(want);
  });

  it('matches total validated ammonia', () => {
    const want = expected.reduce((t, r) => t + Number(r.ammonia_lb ?? 0), 0);
    expect(actual.accounts.reduce((t, a) => t + a.ammoniaLb, 0)).toBe(want);
  });

  it('reproduces the review queue', () => {
    expect(actual.reviewQueue.length).toBe(expectedQueue.length);
    const kinds = actual.reviewQueue.map((r) => r.kind).sort();
    expect(kinds.filter((k) => k === 'numeric_outlier').length)
      .toBe(expectedQueue.filter((r) => r.kind === 'numeric_outlier').length);
    expect(kinds.filter((k) => k === 'unresolved_name').length)
      .toBe(expectedQueue.filter((r) => r.kind === 'unresolved_name').length);
  });

  it('flags the 89,000,000 lb marine terminal and excludes it from scoring', () => {
    const outlier = actual.reviewQueue.find((r) => r.kind === 'numeric_outlier');
    expect(outlier, 'the outlier must be in the review queue, not dropped').toBeDefined();
    expect(outlier?.ammoniaLb).toBe(89_000_000);
    expect(outlier?.name).toMatch(/Neches Terminal/i);
    expect(outlier?.reason).toMatch(/exceeds p99/);
    // The account it belongs to must not have survived on the strength of that record.
    expect(actual.accounts.some((a) => a.ammoniaLb > 5_000_000)).toBe(false);
    expect(actual.stats.flagged).toBe(1);
  });
});

describe('REGRESSION: the VersaCold defect', () => {
  it('VersaCold is NOT canonicalised to a customer', () => {
    const c = canonicalName('VersaCold Logistics');
    expect(c).not.toBeNull();
    expect(KNOWN_CUSTOMERS.has(c ?? '')).toBe(false);
  });
  it('no VersaCold facility appears in the customer set', () => {
    const versa = actual.accounts.filter((a) => /versa/i.test(a.account));
    for (const a of versa) expect(a.isCustomer, `${a.account} flagged as customer`).toBe(false);
  });
  it('every customer flag in the output matches the Python reference', () => {
    for (const row of expected) {
      const a = byName.get(row.account ?? '');
      expect(a?.isCustomer, row.account).toBe(row.is_customer === 'True');
    }
  });
  it('exactly three accounts are flagged as customers', () => {
    const customers = actual.accounts.filter((a) => a.isCustomer).map((a) => a.account).sort();
    expect(customers).toEqual(['Americold Realty Trust', 'Lineage, Inc.', 'United States Cold Storage']);
  });
});

describe('the pilot floor and the sub-threshold queue', () => {
  const queue = actual.reviewQueue;

  /**
   * 354 of 472 resolved companies used to be dropped by the pilot filter with
   * no record at all, which made INGESTION-GATES.md's "nothing is silently
   * dropped" untrue for the largest category of refusal in the system.
   */
  it('queues resolved companies dropped by the pilot floor', () => {
    const below = queue.filter((q) => q.kind === 'below_threshold');
    expect(below.length).toBeGreaterThan(0);
    for (const q of below) {
      expect(q.ammoniaLb, `${q.account} is under the queue floor`).toBeGreaterThanOrEqual(50_000);
      expect(q.ammoniaLb, `${q.account} should have been admitted, not queued`).toBeLessThan(100_000);
      expect(q.action).toMatch(/sub-threshold account/);
    }
  });

  it('admits the single-site companies the old floor was hiding', () => {
    const names = actual.accounts.map((a) => a.account);
    for (const n of ['Harkins Street Holdings', 'DPF Holdings', 'Super Store Industries', 'Charoen Pokphand Foods']) {
      expect(names, `${n} should now be an account`).toContain(n);
    }
  });

  it('nothing sits in both the registry and the below-threshold queue', () => {
    const accountNames = new Set(actual.accounts.map((a) => a.account));
    const below = queue.filter((q) => q.kind === 'below_threshold').map((q) => q.account);
    expect(below.filter((n) => accountNames.has(n))).toEqual([]);
  });
});

describe('REGRESSION: a guarded near-miss is recorded, not just prevented', () => {
  /**
   * The guards stop Sodus Cold Storage being absorbed into the United States
   * Cold Storage CUSTOMER account — but prevention is silent. Without a queue
   * entry the only evidence is a prospect list one company longer, which is
   * exactly as unreadable as the bug was.
   */
  it('queues Sodus as a merge rescue naming the customer it escaped', () => {
    const rescues = actual.reviewQueue.filter((q) => q.kind === 'merge_rescue');
    expect(rescues.length).toBe(1);
    const [sodus] = rescues;
    expect(sodus?.account).toMatch(/sodus/i);
    expect(sodus?.reason).toMatch(/United States Cold Storage/);
    expect(sodus?.reason).toMatch(/CUSTOMER/);
    expect(sodus?.action).toMatch(/separate company/);
  });

  it('does not report a rescue when the bucket key is unchanged', () => {
    // "SCHWANS COMPANY" moves between resolution paths but matchKey normalises
    // both sides to `schwans`, so nothing was rescued. Comparing canonical
    // NAMES reports this as a hit; comparing bucket KEYS does not.
    expect(mergeRescue('SCHWANS COMPANY')).toBeNull();
    expect(mergeRescue('Sodus Cold Storage Co., Inc.')).not.toBeNull();
  });
});

describe('REGRESSION: Perdue Farms is one company', () => {
  it('does not split on the spelled-out legal suffix', () => {
    const perdue = actual.accounts.filter((a) => /perdue/i.test(a.account));
    expect(perdue.length).toBe(1);
    expect(perdue[0]?.aliases).toContain('Perdue Farms Incorporated');
    expect(perdue[0]?.sites).toBe(2);
  });
});

describe('REGRESSION: entity resolution does not over-merge', () => {
  it('distinct companies sharing generic or weak tokens stay separate', () => {
    const names = actual.accounts.map((a) => a.account);
    for (const n of ['United Global Foods', 'United Natural Foods Inc.']) {
      expect(names, `${n} must survive as its own account`).toContain(n);
    }
  });
  /**
   * INGESTION-GATES.md §9 #1, the over-reach half — the measured sibling of the
   * VersaCold defect above, and the more damaging direction.
   *
   * `us cold storage` is a substring of "Sod-us cold storage", so Sodus Cold
   * Storage Co., Inc. (Sodus NY, 14,693 lb, single site, a genuine independent
   * prospect) was absorbed into United States Cold Storage — an existing
   * CUSTOMER — and suppressed from outbound. Nothing errored and nothing was
   * queued; the only symptom was a prospect list one company shorter.
   */
  it('Sodus Cold Storage is not absorbed into the US Cold Storage customer', () => {
    const uscs = byName.get('United States Cold Storage');
    expect(uscs).toBeDefined();
    expect(uscs?.aliases, 'Sodus must not appear as an alias of a customer')
      .not.toContain('Sodus Cold Storage Co., Inc.');
    for (const a of actual.accounts) {
      if (!a.isCustomer) continue;
      for (const alias of a.aliases) {
        expect(/\bsodus\b|\bseaonus\b/i.test(alias), `${alias} absorbed into customer ${a.account}`).toBe(false);
      }
    }
  });

  it('no site is attributed to a customer account it only matched mid-word', () => {
    const suspect = actual.sites.filter(
      (s) => /^(sodus|seaonus)/i.test(s.name) && KNOWN_CUSTOMERS.has(s.account ?? ''),
    );
    expect(suspect.map((s) => `${s.name} -> ${s.account}`)).toEqual([]);
  });

  it('multi-alias accounts really were merged', () => {
    const multi = actual.accounts.filter((a) => a.aliases.length > 1);
    // 54 -> 55: adding `incorporated` to the legal-suffix list merged
    // "Perdue Farms Incorporated" into "Perdue Farms", giving that account a
    // second alias.
    expect(multi.length).toBe(55);
  });
  it('Americold absorbs all four of its reported names', () => {
    const a = byName.get('Americold Realty Trust');
    expect(a).toBeDefined();
    expect(a?.sites).toBe(107);
    expect(a?.aliases.length).toBeGreaterThanOrEqual(4);
  });
});

describe('maxAmmoniaLb', () => {
  it('reads the compact fixture shape', () => {
    const f = fixture.facilities.find((x) => maxAmmoniaLb(x) > 100_000);
    if (f === undefined) throw new Error('no facility above 100,000 lb in the fixture');
    expect(maxAmmoniaLb(f)).toBeGreaterThan(100_000);
  });
  it('reads the live API shape too', () => {
    const f: RmpFacility = {
      facilityId: 'x',
      chemicals: [{ chemicalId: 56, chemicalName: 'Ammonia (anhydrous)', quantity: 42_000 },
                  { chemicalId: 62, chemicalName: 'Chlorine', quantity: 999_999 }],
    };
    expect(maxAmmoniaLb(f)).toBe(42_000);
  });
  it('returns 0 when no ammonia is reported', () => {
    expect(maxAmmoniaLb({ facilityId: 'x' })).toBe(0);
  });
});
