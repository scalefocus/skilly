"use client";
// Chart components isolated into their own module so `recharts` (which pulls in much of d3) is
// code-split into a lazily-loaded chunk via next/dynamic in page.tsx — it no longer ships in the
// usage route's initial JS. SKILLY_SPEC.md §21.
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

export interface DailySeries {
  views: number[];
  installs: number[];
  /** §68.7 — present only while Usage insights is on. */
  uses?: number[];
}

/** Zip the shared day axis with a series into recharts rows. "05-12" labels (MM-DD). */
function chartRows(days: string[], s: DailySeries) {
  return days.map((d, i) => ({ date: d.slice(5), installs: s.installs[i] ?? 0, views: s.views[i] ?? 0, ...(s.uses ? { uses: s.uses[i] ?? 0 } : {}) }));
}

/** The uses line: a third series, dashed, in the secondary accent (§68.7). */
function UsesLine() {
  return <Line type="monotone" dataKey="uses" stroke="var(--accent-2)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} activeDot={{ r: 3 }} />;
}

/** Daily time-series chart — installs (accent) + views (muted). Aggregate AND expanded skills. */
export function UsageChart({ days, series, height = 180 }: { days: string[]; series: DailySeries; height?: number }) {
  const rows = chartRows(days, series);
  return (
    <div style={{ width: "100%", height, marginTop: 18 }}>
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--faint)" }} tickLine={false} axisLine={{ stroke: "var(--line)" }} minTickGap={28} />
          <YAxis tick={{ fontSize: 10, fill: "var(--faint)" }} tickLine={false} axisLine={false} allowDecimals={false} width={46} />
          <Tooltip
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "var(--faint)", fontFamily: "var(--font-mono)", fontSize: 11 }}
          />
          <Line type="monotone" dataKey="installs" stroke="var(--accent)" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
          <Line type="monotone" dataKey="views" stroke="var(--faint)" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} />
          {series.uses && <UsesLine />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface WindowPoint { date: string; views: number; installs: number; uses?: number; people?: number | null }

/** Per-skill chart bound to a breakdown window. `bucket` only drives the x-axis label format:
 *  hour → HH:00, month → YYYY-MM, day/week → MM-DD. A point with `uses` draws the third line and
 *  its tooltip reads "N uses by M people" in day buckets (§68.7). */
export function WindowChart({ points, bucket, height = 150 }: { points: WindowPoint[]; bucket: "hour" | "day" | "week" | "month"; height?: number }) {
  const rows = points.map((p) => ({
    ...p,
    label: bucket === "hour" ? p.date.slice(11, 16) : bucket === "month" ? p.date.slice(0, 7) : p.date.slice(5),
  }));
  const hasUses = points.some((p) => p.uses !== undefined);
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--faint)" }} tickLine={false} axisLine={{ stroke: "var(--line)" }} minTickGap={28} />
          <YAxis tick={{ fontSize: 10, fill: "var(--faint)" }} tickLine={false} axisLine={false} allowDecimals={false} width={46} />
          <Tooltip
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "var(--faint)", fontFamily: "var(--font-mono)", fontSize: 11 }}
            formatter={(value, name, item) => {
              const people = (item as { payload?: { people?: number | null } }).payload?.people;
              if (name === "uses" && typeof people === "number") return [`${value} by ${people} ${people === 1 ? "person" : "people"}`, "uses"];
              return [value as number, name as string];
            }}
          />
          <Line type="monotone" dataKey="installs" stroke="var(--accent)" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
          <Line type="monotone" dataKey="views" stroke="var(--faint)" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} />
          {hasUses && <UsesLine />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Tiny per-row tendency sparkline: installs (accent) over views (faint). No axes. Fills its
 *  container (130px on desktop via .usage-spark; full card width on mobile). */
export function Sparkline({ days, s }: { days: string[]; s: DailySeries }) {
  const rows = chartRows(days, s);
  return (
    <div style={{ width: "100%", height: 36 }}>
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <Line type="monotone" dataKey="views" stroke="var(--faint)" strokeWidth={1} dot={false} isAnimationActive={false} opacity={0.55} />
          <Line type="monotone" dataKey="installs" stroke="var(--accent)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          {s.uses && <Line type="monotone" dataKey="uses" stroke="var(--accent-2)" strokeWidth={1} strokeDasharray="3 2" dot={false} isAnimationActive={false} />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
