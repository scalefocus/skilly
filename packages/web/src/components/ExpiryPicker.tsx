"use client";
// Install-expiry picker: "Never" (null) or a date (≤ maxMonths calendar months out). Emits an ISO
// instant resolved to END of the selected day in the USER's timezone (so "expires June 20" is valid
// through the 20th), or null for never. Past dates aren't selectable; the server re-validates. §23
import { useState } from "react";

const pad = (n: number) => String(n).padStart(2, "0");
const dayStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Add `n` calendar months, clamping a day that overflows a shorter month. Mirrors the server's
 *  lib/settings.addMonths so the picker's max matches the server-enforced horizon. */
function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  const day = r.getDate();
  r.setMonth(r.getMonth() + n);
  if (r.getDate() < day) r.setDate(0);
  return r;
}

/** yyyy-mm-dd (local) -> ISO instant at 23:59:59.999 local that day. */
export function expiryToIso(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 23, 59, 59, 999).toISOString();
}

// onPendingChange fires whenever the selection is "On a date" but no date is picked yet — an
// incomplete choice the caller should treat as a hard block (the install button stays disabled
// until a real date is chosen) rather than silently falling back to "never".
export function ExpiryPicker({
  onChange,
  onPendingChange,
  maxMonths = 12,
}: {
  onChange: (iso: string | null) => void;
  onPendingChange?: (pending: boolean) => void;
  maxMonths?: number;
}) {
  const [never, setNever] = useState(true);
  const [date, setDate] = useState("");
  const today = new Date();
  const min = dayStr(today);
  const max = dayStr(addMonths(today, maxMonths));
  const pending = !never && !date; // "On a date" chosen, awaiting an actual date

  const choose = (nv: boolean, ds: string) => {
    setNever(nv);
    setDate(ds);
    onChange(nv || !ds ? null : expiryToIso(ds));
    onPendingChange?.(!nv && !ds);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <div className="sort-toggle" role="group" aria-label="Install expiry">
        <button type="button" className={`sort-opt${never ? " sort-on" : ""}`} onClick={() => choose(true, date)}>Never</button>
        <button type="button" className={`sort-opt${!never ? " sort-on" : ""}`} onClick={() => choose(false, date)}>On a date</button>
      </div>
      {!never && (
        <input
          type="date"
          min={min}
          max={max}
          value={date}
          required
          aria-invalid={pending}
          onChange={(e) => choose(false, e.target.value)}
          style={{
            padding: "6px 10px",
            borderRadius: "var(--radius-sm)",
            border: `1px solid ${pending ? "var(--accent)" : "var(--line)"}`,
            background: "var(--surface)",
            color: "var(--ink)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
          }}
        />
      )}
      {pending && <span className="muted" style={{ fontSize: 12 }}>pick a date</span>}
    </div>
  );
}
