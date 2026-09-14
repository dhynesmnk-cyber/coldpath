/**
 * Minimal RFC-4180 CSV reader: handles quoted fields, embedded commas, embedded
 * newlines and escaped quotes ("").
 *
 * Used by the HubSpot CSV connector and by the test harness. Deliberately small
 * and dependency-free — a CSV parser is not worth a supply-chain risk, and the
 * quoted-field case is exactly where naive splitting silently corrupts columns.
 */
export type CsvRow = string[];

export function detectDelimiter(sample: string): string {
  const line = sample.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const counts: [string, number][] = [',', ';', '\t', '|'].map((d) => [d, line.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]?.[1] !== undefined && counts[0][1] > 0 ? counts[0][0] : ',';
}

export function parseCsv(text: string, delimiter: string = detectDelimiter(text)): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] ?? '';
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i += 1; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

export function parseCsvObjects(text: string, delimiter?: string): Record<string, string>[] {
  const rows = parseCsv(text, delimiter);
  const head = (rows[0] ?? []).map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    head.forEach((h, i) => { o[h] = r[i] ?? ''; });
    return o;
  });
}
