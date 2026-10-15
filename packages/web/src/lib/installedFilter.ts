// Client-side filter for the Installed Skills page's header search (§23). The installed list is
// small and fully loaded, so the "Search installed skills" box filters the already-fetched rows in
// the browser rather than querying the server — a case-insensitive substring (ILIKE-style) match
// over each row's title, namespace slug, and skill slug, and nothing else (not version, client
// label, IP, or dates). Extracted here as a pure function so the predicate is unit-testable.

import { isBehindLatest, type Freshness } from "@skilly/shared/freshness";

/** The subset of an installed row the header search matches against (§23). */
export interface InstallSearchFields {
  title: string;
  namespaceSlug: string;
  skillSlug: string;
}

/**
 * Does an installed row match a pre-normalized needle (already trimmed + lower-cased)? An empty
 * needle matches everything. Matches title / namespace slug / skill slug on a substring basis.
 */
export function installMatches(row: InstallSearchFields, needle: string): boolean {
  if (!needle) return true;
  return (
    row.title.toLowerCase().includes(needle) ||
    row.namespaceSlug.toLowerCase().includes(needle) ||
    row.skillSlug.toLowerCase().includes(needle)
  );
}

/**
 * Filter installs by a raw (untrimmed, any-case) query, preserving the input order (§23 keeps the
 * alphabetical-by-title ordering among matches). An empty/whitespace query returns the list
 * unchanged (same reference), so "clearing the search restores the full list".
 */
export function filterInstalls<T extends InstallSearchFields>(installs: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return installs;
  return installs.filter((i) => installMatches(i, needle));
}

/**
 * The "Behind latest" chip (§23 "Installed-version freshness"): keeps rows whose freshness is
 * `behind` or `withdrawn` — `current` and `unknown` are hidden. Off (`false`) returns the list
 * unchanged (same reference). Composes with filterInstalls (apply either first; order is
 * preserved either way, so the alphabetical-by-title ordering survives).
 */
export function filterBehind<T extends { freshness: Freshness }>(installs: T[], on: boolean): T[] {
  if (!on) return installs;
  return installs.filter((i) => isBehindLatest(i.freshness));
}

/** The Installed page's sort toggle (§23): A–Z (default) or Recently installed. */
export type InstalledSort = "alpha" | "recent";

/** Per-browser memory of the sort choice (§23) — one preference for both the Mine and System views. */
export const INSTALLED_SORT_KEY = "skilly.installedSort";

/** Read a stored sort value; anything unknown (or nothing stored) falls back to the A–Z default. */
export function parseInstalledSort(raw: string | null | undefined): InstalledSort {
  return raw === "recent" ? "recent" : "alpha";
}

/** Case-insensitive title comparison (the A–Z key, and the Recently-installed tie-break). */
function byTitle(a: { title: string }, b: { title: string }): number {
  const x = a.title.toLowerCase();
  const y = b.title.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Order installed rows for display (§23 sort toggle). `alpha`: title A–Z (case-insensitive), ties by
 * most-recent `installedAt`. `recent`: `installedAt` newest first, ties by title A–Z. Returns a new
 * array (the input — the API's own A–Z order — is left untouched); composes with the filters above.
 */
export function sortInstalls<T extends { title: string; installedAt: string }>(installs: T[], sort: InstalledSort): T[] {
  const time = (i: T) => Date.parse(i.installedAt) || 0;
  return [...installs].sort((a, b) =>
    sort === "recent" ? time(b) - time(a) || byTitle(a, b) : byTitle(a, b) || time(b) - time(a),
  );
}

/** The `@ns/slug` key the ?highlight= param names (§23 "Highlight on arrival"). */
export function installRef(i: { namespaceSlug: string; skillSlug: string }): string {
  return `${i.namespaceSlug}/${i.skillSlug}`;
}

/** Where the already-installed prompt's "Go to skill" lands (§23). */
export function installedHighlightHref(namespaceSlug: string, skillSlug: string): string {
  return `/installed?highlight=${namespaceSlug}/${skillSlug}`;
}
