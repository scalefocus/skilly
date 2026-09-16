// Web Vitals rating bands (SKILLY_SPEC.md §32.7) — Google's published good / needs-improvement /
// poor thresholds, rendered as coloured pills in the RUM routes table. Pure, client-safe.
import type { RumVital } from "./validate";

/** [good ≤, poor >] per metric. LCP/INP/TTFB in ms, CLS unitless. */
export const VITAL_THRESHOLDS: Record<RumVital, readonly [number, number]> = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [0.1, 0.25],
  ttfb: [800, 1800],
};

export type Band = "good" | "needs-improvement" | "poor";

export function bandFor(metric: RumVital, value: number): Band {
  const [good, poor] = VITAL_THRESHOLDS[metric];
  if (value <= good) return "good";
  if (value <= poor) return "needs-improvement";
  return "poor";
}

/** The Pill tone a band renders with. */
export function bandTone(band: Band): "ok" | "warn" | "danger" {
  return band === "good" ? "ok" : band === "needs-improvement" ? "warn" : "danger";
}

/** "1.24 s" above a second, "820 ms" below — compact, fixed precision for table cells. */
export function formatMs(ms: number): string {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

export function formatCls(v: number): string {
  return v.toFixed(v < 0.1 ? 3 : 2);
}
