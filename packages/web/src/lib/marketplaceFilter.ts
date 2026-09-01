// Client-side filter for the Added Marketplaces page's header search (§30.6). The list is small
// and fully loaded, so the box filters the already-fetched rows in the browser rather than
// querying the server — the same non-registry mode the Installed Skills page uses (§10).
// Extracted here as a pure function so the predicate is unit-testable.

/** The subset of an added-marketplace row the header search matches against (§30.6). */
export interface MarketplaceSearchFields {
  /** The public-facing marketplace name, e.g. `skilly-team-a`. */
  name: string;
  /** Namespace slug for a namespace marketplace; null for the public one. */
  namespaceSlug: string | null;
  scope: "public" | "namespace";
}

/**
 * Does a marketplace row match a pre-normalized needle (already trimmed + lower-cased)? An empty
 * needle matches everything. Matches the marketplace name, its namespace slug, and its scope word
 * — so typing "public" finds the public marketplace and "team-a" finds that namespace's.
 */
export function marketplaceMatches(row: MarketplaceSearchFields, needle: string): boolean {
  if (!needle) return true;
  return (
    row.name.toLowerCase().includes(needle) ||
    (row.namespaceSlug?.toLowerCase().includes(needle) ?? false) ||
    row.scope.includes(needle)
  );
}

/**
 * Filter marketplaces by a raw (untrimmed, any-case) query, preserving input order. An empty or
 * whitespace-only query returns the list unchanged (same reference), so clearing the search
 * restores the full list.
 */
export function filterMarketplaces<T extends MarketplaceSearchFields>(rows: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => marketplaceMatches(r, needle));
}
