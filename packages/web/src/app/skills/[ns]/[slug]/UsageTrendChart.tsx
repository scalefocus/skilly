"use client";
// Isolated so `recharts` (much of d3) is code-split into a lazily-loaded chunk via next/dynamic
// in the detail page — it never ships in the route's initial JS. SKILLY_SPEC.md §21.
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";

export interface TrendPoint { date: string; views: number; installs: number }

/** Installs (accent) + views (muted) over time. `bucket` only affects the x-axis label format:
 *  day/week → MM-DD, month → YYYY-MM. */
export function UsageTrendChart({ points, bucket, height = 200 }: { points: TrendPoint[]; bucket: "day" | "week" | "month"; height?: number }) {
  const rows = points.map((p) => ({ ...p, label: bucket === "month" ? p.date.slice(0, 7) : p.date.slice(5) }));
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
          />
          <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" />
          <Line type="monotone" dataKey="installs" name="installs" stroke="var(--accent)" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
          <Line type="monotone" dataKey="views" name="views" stroke="var(--faint)" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
