// Minimal RFC 4180 CSV writer, shared by the audit-log and system-log exports (SKILLY_SPEC.md
// §11/§25). Quotes a cell only when it needs it (contains a comma, quote, or newline), doubling
// embedded quotes — lossless for the JSON blobs an audit row's before/after can carry. A leading
// UTF-8 BOM is prepended so Excel opens non-ASCII (e.g. actor display names) correctly instead of
// mis-detecting the encoding.
const BOM = String.fromCharCode(0xfeff);

function csvCell(value: unknown): string {
  if (value == null) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => csvCell(c.header)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(c.value(r))).join(","));
  return BOM + [head, ...body].join("\r\n") + "\r\n";
}
