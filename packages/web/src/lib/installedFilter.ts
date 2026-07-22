// Client-side filter for the Installed Skills page's header search (§23). The installed list is
// small and fully loaded, so the "Search installed skills" box filters the already-fetched rows in
// the browser rather than querying the server — a case-insensitive substring (ILIKE-style) match
// over each row's title, namespace slug, and skill slug, and nothing else (not version, client
// label, IP, or dates). Extracted here as a pure function so the predicate is unit-testable.

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
