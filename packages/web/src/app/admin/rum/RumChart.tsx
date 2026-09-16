"use client";
// Real-user-monitoring trend chart (SKILLY_SPEC.md §32.7): page views as bars on the left axis,
// p75 LCP and p75 INP as lines on the right (ms). Isolated so `recharts` is code-split into a
// lazily-loaded chunk via next/dynamic in page.tsx — same pattern as ActiveUsersChart.
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface RumChartPoint {
  date: string;
  views: number;
  lcpP75: number | null;
  inpP75: number | null;
}

export function RumChart({ points, bucket, height = 220 }: { points: RumChartPoint[]; bucket: "day" | "week" | "month"; height?: number }) {
  const rows = points.map((p) => ({
    ...p,
    label: bucket === "month" ? p.date.slice(0, 7) : p.date.slice(5),
    lcpP75: p.lcpP75 == null ? null : Math.round(p.lcpP75),
    inpP75: p.inpP75 == null ? null : Math.round(p.inpP75),
  }));
  // Fewer than 3 points has no line to speak of — draw explicit markers (§4/§32.7 rule).
  const sparse = rows.length < 3;
  return (
    <div style={{ width: "100%", height }} data-testid="rum-chart">
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--faint)" }} tickLine={false} axisLine={{ stroke: "var(--line)" }} minTickGap={28} />
          <YAxis yAxisId="views" tick={{ fontSize: 10, fill: "var(--faint)" }} tickLine={false} axisLine={false} allowDecimals={false} width={40} />
          <YAxis yAxisId="ms" orientation="right" tick={{ fontSize: 10, fill: "var(--faint)" }} tickLine={false} axisLine={false} width={48} unit=" ms" />
          <Tooltip
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "var(--faint)", fontFamily: "var(--font-mono)", fontSize: 11 }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar yAxisId="views" dataKey="views" name="page views" fill="var(--line)" radius={[3, 3, 0, 0]} maxBarSize={28} />
          <Line yAxisId="ms" type="monotone" dataKey="lcpP75" name="p75 LCP" stroke="var(--accent)" strokeWidth={2} connectNulls dot={sparse ? { r: 3, fill: "var(--accent)", strokeWidth: 0 } : false} activeDot={{ r: 3 }} />
          <Line yAxisId="ms" type="monotone" dataKey="inpP75" name="p75 INP" stroke="var(--faint)" strokeWidth={1.5} connectNulls dot={sparse ? { r: 3, fill: "var(--faint)", strokeWidth: 0 } : false} activeDot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
