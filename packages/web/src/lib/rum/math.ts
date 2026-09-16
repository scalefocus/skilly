// Small pure helpers behind the RUM aggregates (SKILLY_SPEC.md §32.7). The 7d/30d ranges compute a
// TRUE p75 over raw samples (Postgres `percentile_cont(0.75)`; `p75` below is its in-process twin
// for tests and the client); the 90d/All ranges read the daily rollup, where a percentile cannot
// be re-aggregated, so they show the views-weighted mean of the daily p75 values instead.

/** `percentile_cont(0.75)` semantics: linear interpolation between the two nearest ranks. */
export function p75(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = 0.75 * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Weighted mean of `{ value, weight }` pairs, ignoring null values and zero weights. */
export function weightedMean(pairs: readonly { value: number | null; weight: number }[]): number | null {
  let num = 0;
  let den = 0;
  for (const p of pairs) {
    if (p.value == null || !Number.isFinite(p.value) || p.weight <= 0) continue;
    num += p.value * p.weight;
    den += p.weight;
  }
  return den > 0 ? num / den : null;
}

/** The day/week/month bucket for a range, on the same span-adaptive rule as the DAU + usage charts. */
export function rumBucketFor(range: 7 | 30 | 90 | "all", historySpanDays: number | null): "day" | "week" | "month" {
  if (historySpanDays == null) return "day";
  const span = range === "all" ? historySpanDays : Math.min(range, historySpanDays);
  return span <= 92 ? "day" : span <= 730 ? "week" : "month";
}
