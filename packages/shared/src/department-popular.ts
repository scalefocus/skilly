// Popular in your department (SKILLY_SPEC.md §66) — the fixed rules and the department key, shared
// by the web API (the query), the home page (its copy) and the tests. Client-safe (no node deps);
// exported via the barrel and the `@skilly/shared/department-popular` subpath.

/** The trailing window a colleague's FIRST adoption (skill_installs.first_at) must fall in (§66.1 #1). */
export const DEPARTMENT_POPULAR_WINDOW_DAYS = 90;

/** The privacy floor: a skill needs at least this many colleague adopters to appear (§66.1 #4). */
export const DEPARTMENT_POPULAR_MIN_COLLEAGUES = 2;

/** At most this many cards on the home page (§66.1 #7). */
export const DEPARTMENT_POPULAR_LIMIT = 6;

/** How long one department's adopter counts are cached in the web process (§66.4). */
export const DEPARTMENT_POPULAR_CACHE_MS = 10 * 60_000;

/**
 * SQL `btrim(x)` strips leading and trailing SPACES only — mirror exactly that, not String#trim.
 * A linear scan from both ends, deliberately not a regex: `/ +$/` backtracks quadratically on a long
 * run of spaces followed by a non-space, and the department is directory data we don't control.
 */
function btrim(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && raw.charCodeAt(start) === 32) start++;
  while (end > start && raw.charCodeAt(end - 1) === 32) end--;
  return raw.slice(start, end);
}

/**
 * The key two people's departments are compared by (§66.2): trimmed and lower-cased, so
 * `Engineering` and ` engineering ` are one team. Inner spaces are kept as they are. A department
 * that is missing or empty after trimming is no department (`null`). Mirrors the SQL
 * `lower(btrim(department))` that the query matches on (both sides normalized in SQL) and that the
 * migration 0107 index is built on; the web uses this key for "has a department?" and as the cache key.
 */
export function departmentKey(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const t = btrim(raw);
  return t === "" ? null : t.toLowerCase();
}

/** The department as the viewer's heading shows it: trimmed, with its own capitals (§66.5). */
export function departmentLabel(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const t = btrim(raw);
  return t === "" ? null : t;
}

/** The card chip's text, e.g. "3 colleagues" (N is always ≥ the floor, so always plural). */
export function colleaguesLabel(n: number): string {
  return `${n} ${n === 1 ? "colleague" : "colleagues"}`;
}

/** The chip's tooltip (§66.5). */
export function colleaguesTitle(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"} in your department adopted this in the last ${DEPARTMENT_POPULAR_WINDOW_DAYS} days`;
}
