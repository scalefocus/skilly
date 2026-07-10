"use client";
// A From/To date-range filter built on native <input type="date"> (the OS renders the calendar),
// styled like ExpiryPicker. Values are yyyy-mm-dd local-day strings ("" = unset); callers convert
// to UTC instants with dayStartIso/dayEndIso when building a query. Used by /audit and /system-log.
// SKILLY_SPEC.md §11, §25.

/** yyyy-mm-dd (local) -> ISO instant at 00:00:00.000 local that day (inclusive range start). */
export function dayStartIso(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 0, 0, 0, 0).toISOString();
}
/** yyyy-mm-dd (local) -> ISO instant at 23:59:59.999 local that day (inclusive range end). */
export function dayEndIso(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 23, 59, 59, 999).toISOString();
}

const pad = (n: number) => String(n).padStart(2, "0");
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const inputStyle = {
  padding: "6px 10px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontFamily: "var(--font-mono)",
  fontSize: 13,
} as const;
const labelStyle = { fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--faint)" } as const;

export function DateRangeFilter({
  from,
  to,
  onChange,
}: {
  /** yyyy-mm-dd local-day strings; "" = unset. */
  from: string;
  to: string;
  onChange: (next: { from: string; to: string }) => void;
}) {
  const today = todayStr();
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={labelStyle}>From</span>
        <input type="date" value={from} max={to || today} onChange={(e) => onChange({ from: e.target.value, to })} style={inputStyle} aria-label="From date" />
      </label>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={labelStyle}>To</span>
        <input type="date" value={to} min={from || undefined} max={today} onChange={(e) => onChange({ from, to: e.target.value })} style={inputStyle} aria-label="To date" />
      </label>
    </div>
  );
}
