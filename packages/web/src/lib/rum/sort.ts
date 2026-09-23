// Ordering for the real user monitoring routes table (SKILLY_SPEC.md §32.7). Pure so the rules
// are unit-tested: the "All routes" totals row is not a ranked route — it is excluded from the
// sort and always comes first; the route rows order by the column's numeric value, ties broken by
// label A→Z, and rows with no value sink to the bottom (A→Z among themselves) in either direction.
import { RUM_ROUTE_ALL } from "./routes";

export type RumSortDir = "asc" | "desc";

export function sortRouteRows<R extends { route: string; label: string }, K extends keyof R>(
  rows: readonly R[],
  key: K,
  dir: RumSortDir,
): R[] {
  const all = rows.find((r) => r.route === RUM_ROUTE_ALL);
  const rest = rows.filter((r) => r.route !== RUM_ROUTE_ALL);
  const sign = dir === "asc" ? 1 : -1;
  const valueOf = (r: R): number | null => {
    const v = r[key];
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  rest.sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av == null && bv == null) return a.label.localeCompare(b.label);
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * sign || a.label.localeCompare(b.label);
  });
  return all ? [all, ...rest] : rest;
}
