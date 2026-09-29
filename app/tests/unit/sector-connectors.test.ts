import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normaliseDirectory } from '@/connectors/district-energy/normalise.js';
import type { DirectoryRow } from '@/connectors/district-energy/normalise.js';
import { normalisePlants } from '@/connectors/cement/normalise.js';
import type { CementPlantRow } from '@/connectors/cement/normalise.js';
import { maxConnectorKw, normaliseStations } from '@/connectors/ev-depot/normalise.js';
import type { AfdcStationRow } from '@/connectors/ev-depot/normalise.js';
import { CEMENT_SOURCES } from '@/connectors/cement/constants.js';
import { DISTRICT_ENERGY_SOURCES } from '@/connectors/district-energy/constants.js';
import { EV_DEPOT_SOURCES } from '@/connectors/ev-depot/constants.js';
import { continuousProcessExclusion } from '@/lib/gates/exclusion.js';
import { validateNumericField } from '@/lib/validation/outliers.js';

/**
 * Sector-connector unit tests — EXPANSION-PLAN.md §6 steps 3, 4, 7.
 * Recorded-shape fixtures (tests/fixtures/sectors), pure functions, no DB.
 */
const dir = fileURLToPath(new URL('../fixtures/sectors', import.meta.url));
const rows = <T>(f: string): T[] =>
  (JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { rows: T[] }).rows;

describe('district-energy normaliseDirectory', () => {
  const result = normaliseDirectory(rows<DirectoryRow>('directory-rows.json'));

  it('accepts well-formed rows with mandatory provenance', () => {
    expect(result.records).toHaveLength(2);
    for (const r of result.records) {
      expect(r.sourceUrl).toMatch(/^https:\/\//);   // G0
      expect(r.licence.length).toBeGreaterThan(0);  // licence non-nullable
      expect(r.proxyUnit).toBe('mw_th');
      expect(r.state).toBe(r.state?.toUpperCase()); // normalised
    }
  });

  it('routes malformed rows to review instead of dropping them', () => {
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0]!.reason).toContain('G0');
    expect(result.rejected[1]!.reason).toContain('capacity_mw_th');
  });
});

describe('cement normalisePlants', () => {
  const result = normalisePlants(rows<CementPlantRow>('cement-rows.json'));

  it('parses thousands separators and keeps USGS provenance', () => {
    const newport = result.records.find((r) => r.name === 'Newport Cement Plant');
    expect(newport?.proxyValue).toBe(2700);
    expect(newport?.sourceUrl).toContain('pubs.usgs.gov');
  });

  it('refuses nameless and negative-capacity rows', () => {
    expect(result.records).toHaveLength(2);
    expect(result.rejected).toHaveLength(2);
  });

  it('every cement record is caught by the continuous-process gate before scoring', () => {
    for (const r of result.records) {
      const verdict = continuousProcessExclusion(r);
      expect(verdict.excluded).toBe(true);
      expect(verdict.ruleId).toBe('X1-naics');
    }
  });
});

describe('ev-depot normaliseStations', () => {
  const result = normaliseStations(rows<AfdcStationRow>('afdc-rows.json'));

  it('maxConnectorKw handles semicolon-delimited AFDC power fields', () => {
    expect(maxConnectorKw('50;150;')).toBe(150);
    expect(maxConnectorKw('')).toBeNull();
    expect(maxConnectorKw(null)).toBeNull();
  });

  it('keeps only fleet/private-access stations as depot candidates', () => {
    expect(result.records.map((r) => r.name).sort()).toEqual(
      ['Fresno Logistics Center Depot', 'School Bus Yard Depot'].sort(),
    );
    const publicMall = result.rejected.find((x) => (x.raw as AfdcStationRow).StationName === 'Public Mall Charger');
    expect(publicMall?.reason).toContain('public-retail');
  });

  it('outlier gate runs on the charger-kW proxy (§6 step 7 verification)', () => {
    const withOutlier = [...result.records, { ...result.records[0]!, name: 'Units Error Depot', proxyValue: 50_000_000 }];
    const { stats } = validateNumericField(withOutlier, (r) => r.proxyValue, 'charger kW');
    expect(stats.flagged).toBe(1);
  });
});

describe('universe source registry ↔ prototype parity', () => {
  const html = readFileSync(fileURLToPath(new URL('../../../../prototype/coldpath-sectors-prototype.html', import.meta.url)), 'utf8');
  const all = [...CEMENT_SOURCES, ...DISTRICT_ENERGY_SOURCES, ...EV_DEPOT_SOURCES];

  it('has 12 registered sources across three verticals', () => {
    expect(all).toHaveLength(12);
    expect(CEMENT_SOURCES).toHaveLength(4);
    expect(DISTRICT_ENERGY_SOURCES).toHaveLength(4);
    expect(EV_DEPOT_SOURCES).toHaveLength(4);
  });

  it('every connector URL also appears in the sector prototype', () => {
    for (const s of all) expect(html).toContain(s.url);
  });

  it('every URL is https', () => {
    for (const s of all) expect(s.url.startsWith('https://')).toBe(true);
  });
});
