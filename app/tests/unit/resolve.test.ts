import { describe, expect, it } from 'vitest';
import { CANONICAL_PARENTS, CANONICAL_PARENT_SOURCES, canonicaliseParent, canonicalName, displayName, guardPattern, KNOWN_CUSTOMERS, matchKey } from '@/lib/resolve/canonical.js';
import { distMatch, distinctive, isAcceptableMatch, scoreCandidate, strongTokens } from '@/lib/resolve/match.js';
import { isJunkName, levenshtein, normName, tokenSim } from '@/lib/resolve/normalise.js';
import { median, OUTLIER_FACTOR, percentile, validateNumericField } from '@/lib/validation/outliers.js';
import { modeByInsertion, pyRound, pySorted } from '@/lib/resolve/pycompat.js';

describe('normalisation', () => {
  it('strips legal suffixes and punctuation', () => {
    expect(normName('Americold Logistics, LLC')).toBe('americold logistics');
    expect(normName('The Kroger Co.')).toBe('kroger');
    expect(normName('C&S Wholesale Grocers')).toBe('c&s wholesale grocers');
  });
  it('identifies junk names', () => {
    for (const j of ['NA', 'N/A', '', 'unknown', '-', 'test']) expect(isJunkName(j), j).toBe(true);
    expect(isJunkName('JDB, Inc.')).toBe(false);
  });
  it('computes Levenshtein distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('abc', 'abc')).toBe(0);
  });
});

describe('matchKey vs displayName — the DFA split-bucket regression', () => {
  it('a canonical rule and its plain form produce the SAME bucket key', () => {
    // The original port lowercased the fallback path but returned title case from
    // the rule path, so "Dairy Farmers of America" split into two accounts.
    const viaRule = canonicalName('DFA Dairy Brands Fluid, LLC');
    const viaFallback = canonicalName('Dairy Farmers of America');
    expect(viaRule).toBe('Dairy Farmers of America');
    expect(viaFallback).toBe('Dairy Farmers of America');
    expect(matchKey(viaRule ?? '')).toBe(matchKey(viaFallback ?? ''));
  });
  it('case and punctuation variants collapse to one key', () => {
    for (const pair of [
      ["BJ's Wholesale Club, Inc.", 'BJs Wholesale Club'],
      ['Nor-Am Cold Storage', 'NorAm Cold Storage'],
      ['SYSCO Corporation', 'Sysco Corporation'],
      ['Americold Logistics, LLC', 'AMERICOLD LOGISTICS'],
    ] as const) {
      expect(matchKey(pair[0]), pair.join(' vs ')).toBe(matchKey(pair[1]));
    }
  });
  it('DOCUMENTED LIMITATION: hyphenated vs spaced variants do NOT merge', () => {
    // Punctuation is REMOVED, not replaced with a space, so "Wayne-Sanderson"
    // becomes "waynesanderson" while "Wayne Sanderson" stays "wayne sanderson".
    // Both refer to the same company and they land in different buckets.
    //
    // This is inherited from the Python reference and is deliberately preserved:
    // a port that "improves" matching silently cannot be verified against its
    // reference. Merging these is the job of the M3 human resolution queue, which
    // is where a person confirms that two buckets are one company.
    expect(matchKey('Wayne-Sanderson Farms')).not.toBe(matchKey('Wayne Sanderson Farms'));
    expect(matchKey('Wayne-Sanderson Farms')).toBe('waynesanderson farms');
  });

  it('display names stay properly capitalised', () => {
    expect(displayName('Western Precooling Systems, LLC')).toBe('Western Precooling Systems');
    expect(displayName("Bozzuto's Inc.")).toBe('Bozzutos');
  });
});

describe('pycompat shims', () => {
  it('pyRound is half-to-even, not half-up', () => {
    expect(pyRound(0.5)).toBe(0);
    expect(pyRound(1.5)).toBe(2);
    expect(pyRound(2.5)).toBe(2);   // Math.round would give 3
    expect(pyRound(3.5)).toBe(4);
    expect(pyRound(2.4)).toBe(2);
    expect(pyRound(2.6)).toBe(3);
  });
  it('modeByInsertion breaks ties by first insertion, like Counter.most_common', () => {
    expect(modeByInsertion(['b', 'a', 'b', 'a'])).toBe('b');
    expect(modeByInsertion(['a', 'b', 'b', 'a'])).toBe('a');
    expect(modeByInsertion<string>([])).toBeUndefined();
  });
  it('pySorted uses code-point order', () => {
    expect(pySorted(['b', 'A', 'a'])).toEqual(['A', 'a', 'b']);
  });
});

describe('canonical parent resolution', () => {
  it('maps every known alias form to its canonical parent', () => {
    const cases: [string, string][] = [
      ['Americold', 'Americold Realty Trust'],
      ['Americold Logistics, LLC', 'Americold Realty Trust'],
      ['AmeriCold Logistics LLC', 'Americold Realty Trust'],
      ['Americold Realty', 'Americold Realty Trust'],
      ['Lineage', 'Lineage, Inc.'],
      ['Lineage Logistics LLC', 'Lineage, Inc.'],
      ['Lineage  Jessup', 'Lineage, Inc.'],
      ['Kroger, Inc.', 'The Kroger Co.'],
      ['The Kroger Company', 'The Kroger Co.'],
      ['Sysco Corporation', 'Sysco Corporation'],
      ['Sysco Foods', 'Sysco Corporation'],
      ['Tyson Foods Inc.', 'Tyson Foods, Inc.'],
      ["Schwan's Company", "Schwan's Company"],
      ['United States Cold Storage, Inc.', 'United States Cold Storage'],
    ];
    for (const [input, expected] of cases) {
      expect(canonicalName(input), `${input} -> ${expected}`).toBe(expected);
    }
  });

  /**
   * INGESTION-GATES.md §9 #1 — "customer suppression must not over-reach" (blocking).
   *
   * The canonical pass runs FIRST and returns on the first hit, so a substring
   * match here is final: it never reaches the distinctive-token protection.
   * `us cold storage` matched "Sod-us cold storage" and put Sodus Cold Storage
   * Co. — an independent prospect — inside the United States Cold Storage
   * CUSTOMER account, suppressing it from outbound with no queue entry.
   *
   * The table below is the measured family, not just the one instance.
   */
  it('never matches a canonical pattern mid-word', () => {
    const mustNotMatchARule: [string, string][] = [
      ['Sodus Cold Storage Co., Inc.', 'us cold storage'],
      ['Seaonus Cold Storage', 'us cold storage'],
      ['Rinaldi Fine Foods', 'aldi'],
      ['Baldinger Bakery', 'aldi'],
      ['Garibaldi Produce Co', 'aldi'],
      ['Aldine Cold Storage', 'aldi'],
      ['Nestlerode Farms', 'nestl'],
      ['Tysons Corner Provisions', 'tyson'],
      ['WJBS Holdings', 'jbs'],
    ];
    for (const [name, why] of mustNotMatchARule) {
      const r = canonicaliseParent(name);
      expect(r?.by, `${name} must not hit the '${why}' rule`).not.toBe('rule');
      expect(KNOWN_CUSTOMERS.has(r?.name ?? ''), `${name} must not be suppressed`).toBe(false);
    }
  });

  /**
   * The guards are asymmetric on purpose: a blanket trailing guard would break
   * these, which are CORRECT. "U.S. Foodservice" is the former name of US Foods;
   * "Performance Foodservice" is Performance Food Group's operating brand.
   */
  it('still resolves legitimate matches that continue past the pattern', () => {
    const cases: [string, string][] = [
      ['U.S. Foodservice, Inc.', 'US Foods Holding Corp.'],
      ['Performance Foodservice - Arizona', 'Performance Food Group'],
      ['AmericoldLogistics Services', 'Americold Realty Trust'],
      ['Nestle Purina', 'Nestlé USA'],
      ['Cargill Meat Solutions', 'Cargill, Inc.'],
    ];
    for (const [input, expected] of cases) {
      expect(canonicalName(input), `${input} -> ${expected}`).toBe(expected);
    }
  });

  /**
   * Structural, not case-by-case: asserts the property over the whole table so a
   * NEW row cannot reintroduce the defect. Probes each pattern with a letter
   * glued to the front of a name it is supposed to match.
   */
  it('no pattern in the table can match mid-word (meta-test)', () => {
    for (const [source] of CANONICAL_PARENT_SOURCES) {
      if (source.startsWith('^')) continue;          // already start-anchored
      // Build a plain-text probe the UNGUARDED pattern would have matched: take
      // the first alternative and drop the regex metacharacters.
      const [first = ''] = source.split('|');
      const literal = first
        .replace('[e\u00e9]', 'e')     // character class -> one member
        .replace(/\\.\?/g, '')        // optional escaped literal (\.?) -> drop it
        .replace(/\./g, 'z')          // a bare '.' still needs SOME character
        .replace(/[?\\]/g, '');       // leftover optional markers and escapes
      if (literal.length === 0) continue;
      const probe = `x${literal}`;
      expect(new RegExp(source).test(probe), `probe '${probe}' is not a valid witness`).toBe(true);
      expect(guardPattern(source).test(probe), `'${source}' still matches mid-word`).toBe(false);
    }
  });

  it('every source in the table compiles to a guarded pattern', () => {
    expect(CANONICAL_PARENTS.length).toBe(CANONICAL_PARENT_SOURCES.length);
    for (const [pattern] of CANONICAL_PARENTS) {
      expect(pattern.source).toMatch(/\(\?<!\[a-z0-9\]\)|\^/);
    }
  });

  it('suppression set contains every alias form of every customer', () => {
    expect(KNOWN_CUSTOMERS.has('Americold Realty Trust')).toBe(true);
    expect(KNOWN_CUSTOMERS.has('Lineage, Inc.')).toBe(true);
    expect(KNOWN_CUSTOMERS.has('United States Cold Storage')).toBe(true);
  });

  it('returns null for junk rather than inventing an account', () => {
    for (const j of ['NA', 'N/A', '', null, undefined]) {
      expect(canonicalName(j), String(j)).toBeNull();
    }
  });

  it('keeps short acronyms resolvable — the JDB / ACS regression', () => {
    // A minimum-length rule wrongly rejected these as junk in the first version.
    expect(matchKey('JDB, Inc.')).toBe('jdb');
    expect(matchKey('ACS-LLC')).toBe('acs');
    expect(canonicalName('JDB, Inc.')).toBe('JDB');
    expect(canonicalName('ACS-LLC')).toBe('ACS');
  });
});

describe('distinctive-token matching — the VersaCold regression', () => {
  it('versacold and americold share NO distinctive token', () => {
    expect(distinctive('VersaCold Logistics')).toEqual(['versacold']);
    expect(distinctive('Americold Logistics')).toEqual(['americold']);
    const dm = distMatch('VersaCold Logistics', 'Americold Logistics');
    expect(dm.strongShared).toBe(0);
    expect(dm.shared).toBe(0);
  });

  it('whole-string similarity alone WOULD have merged them (the original defect)', () => {
    // Documents why the defect happened: edit distance between the two names is small.
    expect(tokenSim('versacold', 'americold')).toBeLessThan(0.6);
    expect(levenshtein('versacold', 'americold')).toBe(4);
  });

  it('does not merge companies sharing only a generic token', () => {
    expect(distMatch('Penske Logistics', 'VersaCold Logistics').shared).toBe(0);
    expect(distMatch('Vertical Cold Storage', 'Sodus Cold Storage').shared).toBe(0);
  });

  it('does not merge companies sharing only a weak discriminator', () => {
    // "global" and "foods" are GENERIC; "united" is WEAK. So United Global Foods
    // has no strong token at all, and a shared "united" cannot authorise a merge.
    expect(strongTokens('United Global Foods')).toEqual([]);
    expect(distinctive('United Global Foods')).toEqual(['united']);
    const dm = distMatch('United Global Foods', 'United Natural Foods');
    expect(dm.shared).toBe(1);          // they DO share "united"...
    expect(dm.strongShared).toBe(0);    // ...but it is not distinctive
    expect(isAcceptableMatch(scoreCandidate('United Global Foods', 'United Natural Foods').score, dm)).toBe(false);
  });

  it('a shared distinctive token DOES authorise a match', () => {
    const dm = distMatch('Sysco Corporation', 'Sysco Foods');
    expect(dm.strongShared).toBe(1);
    const { score } = scoreCandidate('Sysco Corporation', 'Sysco Foods');
    expect(isAcceptableMatch(score, dm)).toBe(true);
  });

  it('DOES match legitimate typo variants via distinctive tokens', () => {
    // "Americold Logisitcs" is a real typo in the RMP data.
    expect(distMatch('Americold Logisitcs', 'Americold Logistics').strongShared).toBe(1);
    expect(distMatch('AmeriCold Logistics LLC', 'Americold Logistics').strongShared).toBe(1);
  });
});

describe('numeric validation gate', () => {
  it('flags the 89M lb marine terminal in a realistic distribution', () => {
    // Mirrors the real pull: a long tail of small charges, a handful of large
    // plants, and one impossible record. 755 sites in production, 300 here.
    const values: number[] = [];
    for (let i = 0; i < 250; i += 1) values.push(5_000 + ((i * 7919) % 60_000));
    values.push(150_000, 158_000, 180_000, 200_000, 250_000, 400_000, 715_862);
    values.push(89_000_000);
    const { results, stats } = validateNumericField(values.map((v) => ({ v })), (r) => r.v, 'ammonia_lb');
    expect(stats.flagged).toBe(1);
    expect(results.filter((r) => !r.validated).map((r) => r.record.v)).toEqual([89_000_000]);
    const note = results.find((r) => !r.validated)?.validationNote ?? '';
    expect(note).toMatch(/exceeds p99/);
    expect(note).toMatch(/human review/);
    expect(stats.p99).toBeLessThan(1_000_000);
  });

  it('DOCUMENTED LIMITATION: the gate is inert on very small samples', () => {
    // With few records, p99 IS the maximum, so the ceiling sits above every value
    // and nothing can be flagged. A single-account or 8-row import gets no
    // outlier protection at all. In production the RMP pull supplies 748+ sites,
    // so the gate has a distribution to work with — but a caller ingesting a small
    // CRM file must not assume numeric validation ran.
    const small = [20_000, 25_000, 18_000, 150_000, 200_000, 715_862, 89_000_000, 30_000];
    const { stats } = validateNumericField(small.map((v) => ({ v })), (r) => r.v, 'ammonia_lb');
    expect(stats.flagged).toBe(0);
    expect(stats.p99).toBe(89_000_000);
  });
  it('percentile and median are computed over positive values only', () => {
    expect(percentile([0, 0, 10, 20, 30], 0.99)).toBe(30);
    expect(median([10, 20, 30])).toBe(20);
    expect(percentile([], 0.5)).toBe(0);
  });
  it('exposes the factor it used', () => {
    expect(OUTLIER_FACTOR).toBe(10);
  });
});
