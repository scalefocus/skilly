"use client";
// Isolated so `recharts` is code-split into a lazily-loaded chunk via next/dynamic in the admin
// page — it never ships in the route's initial JS (same pattern as the per-skill UsageTrendChart).
// SKILLY_SPEC.md §4.
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

export interface DauPoint { date: string; count: number }

/** Active-user count over time. `bucket` only affects the x-axis label format: day/week → MM-DD,
 *  month → YYYY-MM (mirrors UsageTrendChart's convention). */
export function ActiveUsersChart({ points, bucket, height = 180 }: { points: DauPoint[]; bucket: "day" | "week" | "month"; height?: number }) {
  const rows = points.map((p) => ({ ...p, label: bucket === "month" ? p.date.slice(0, 7) : p.date.slice(5) }));
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--faint)" }} tickLine={false} axisLine={{ stroke: "var(--line)" }} minTickGap={28} />
          <YAxis tick={{ fontSize: 10, fill: "var(--faint)" }} tickLine={false} axisLine={false} allowDecimals={false} width={40} />
          <Tooltip
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "var(--faint)", fontFamily: "var(--font-mono)", fontSize: 11 }}
          />
          <Line type="monotone" dataKey="count" name="active users" stroke="var(--accent)" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
