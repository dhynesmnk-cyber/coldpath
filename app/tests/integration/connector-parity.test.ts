import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aggregate, maxAmmoniaLb } from '@/connectors/epa-rmp/aggregate.js';
import { canonicalName, KNOWN_CUSTOMERS } from '@/lib/resolve/canonical.js';
import { parseCsvObjects } from '@/lib/csv.js';
import type { RmpFacility } from '@/connectors/epa-rmp/types.js';

/**
 * PARITY TEST — PRODUCT-PLAN.md §10 risk #3.
 *
 * The Python connector (phase1/connectors/epa_rmp.py) is the reference
 * implementation. It was run against the live EPA RMP API and its output is
 * committed as CSV. This test runs the TypeScript port against the SAME
 * 1,382-facility input and diffs every field of every account.
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
  it('has a committed Python reference to compare against', () => {
    expect(expected.length).toBe(118);
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

describe('REGRESSION: entity resolution does not over-merge', () => {
  it('distinct companies sharing generic or weak tokens stay separate', () => {
    const names = actual.accounts.map((a) => a.account);
    for (const n of ['United Global Foods', 'United Natural Foods Inc.']) {
      expect(names, `${n} must survive as its own account`).toContain(n);
    }
  });
  it('multi-alias accounts really were merged', () => {
    const multi = actual.accounts.filter((a) => a.aliases.length > 1);
    // 58 accounts were filed under more than one legal name in the live pull.
    // This rose from 54 when matchKey stopped splitting on punctuation: the four
    // extra are the spellings that used to become separate accounts.
    expect(multi.length).toBe(58);
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

describe('every flagged site reaches the review queue', () => {
  /**
   * Synthetic, because the live pull cannot exercise this path: its single
   * numeric outlier belongs to an account that the pilot filter drops, so the
   * bug was invisible in the fixture.
   *
   * A flagged site is excluded from its account's scoring totals. If it is also
   * excluded from the review queue — which it was, whenever its account survived
   * — it contributes to no number a human ever sees and appears on no screen.
   * That is the exact failure the numeric gate exists to prevent.
   */
  const site = (id: string, ammoniaLb: number): RmpFacility => ({
    facilityId: id,
    facilityName: `Plant ${id}`,
    parentCompanyName: 'Synthetic Cold Holdings',
    city: 'Testville',
    state: 'PA',
    naicsCode: '49312',
    _chem: [{ id: 56, name: 'Ammonia (anhydrous)', qty: ammoniaLb }],
  });

  // 200 normal sites so the p99 lands on a NORMAL value. With only a handful the
  // outlier becomes its own p99 and the gate never fires — which is how the first
  // version of this test passed against the unfixed code.
  const NORMAL_SITES = 200;
  const facilities: RmpFacility[] = [
    ...Array.from({ length: NORMAL_SITES }, (_, i) => site(`ok-${i}`, 20_000)),
    site('outlier', 500_000_000),
  ];
  const result = aggregate(facilities);

  it('keeps the account alive on its validated sites alone', () => {
    const account = result.accounts.find((a) => a.account === 'Synthetic Cold Holdings');
    expect(account).toBeDefined();
    expect(account?.unvalidatedSites).toBe(1);
  });

  it('queues the flagged site even though its account survived', () => {
    const queued = result.reviewQueue.filter((r) => r.kind === 'numeric_outlier');
    expect(queued.map((r) => r.rmpId)).toContain('outlier');
  });

  it('excludes the flagged value from the account total', () => {
    const account = result.accounts.find((a) => a.account === 'Synthetic Cold Holdings');
    expect(account?.ammoniaLb).toBe(NORMAL_SITES * 20_000);
  });
});
