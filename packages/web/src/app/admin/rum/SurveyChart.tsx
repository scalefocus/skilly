"use client";
// Feedback-survey satisfaction trend (SKILLY_SPEC.md §36.9): average `general.overall` per bucket
// (right axis, stars) with the response count as bars (left axis). Withheld buckets (fewer than 5
// responses) arrive as nulls and render as gaps. Code-split like RumChart.
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface SurveyChartPoint {
  date: string;
  n: number | null;
  overallAvg: number | null;
}

export function SurveyChart({ points, bucket, height = 200 }: { points: SurveyChartPoint[]; bucket: "day" | "week" | "month"; height?: number }) {
  const rows = points.map((p) => ({ ...p, label: bucket === "month" ? p.date.slice(0, 7) : p.date.slice(5) }));
  const sparse = rows.length < 3;
  return (
    <div style={{ width: "100%", height }} data-testid="survey-chart">
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--faint)" }} tickLine={false} axisLine={{ stroke: "var(--line)" }} minTickGap={28} />
          <YAxis yAxisId="n" tick={{ fontSize: 10, fill: "var(--faint)" }} tickLine={false} axisLine={false} allowDecimals={false} width={40} />
          <YAxis yAxisId="stars" orientation="right" domain={[1, 5]} ticks={[1, 2, 3, 4, 5]} tick={{ fontSize: 10, fill: "var(--faint)" }} tickLine={false} axisLine={false} width={40} unit=" ★" />
          <Tooltip
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "var(--faint)", fontFamily: "var(--font-mono)", fontSize: 11 }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar yAxisId="n" dataKey="n" name="responses" fill="var(--line)" radius={[3, 3, 0, 0]} maxBarSize={28} />
          <Line yAxisId="stars" type="monotone" dataKey="overallAvg" name="overall satisfaction" stroke="#e0a01e" strokeWidth={2} connectNulls={false} dot={sparse ? { r: 3, fill: "#e0a01e", strokeWidth: 0 } : false} activeDot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
