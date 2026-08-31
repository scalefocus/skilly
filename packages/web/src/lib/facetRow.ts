// The two rules that govern a collapsible facet row's state on mount (SKILLY_SPEC.md §10/§26).
// They are separated on purpose: the row can be OPEN while the stored preference stays CLOSED.
// Both the catalog and the Requested-skills page use these, so the two pages cannot drift.

/**
 * What the row actually does on arrival: the stored preference, OR forced open because a filter of
 * its own is already active. Auto-expand exists so a restored filter is never invisible — a
 * collapsed row plus a persisted `category` would otherwise present a silently-filtered list with
 * nothing on screen explaining the result count.
 */
export function initialFacetRowOpen(storedOpen: unknown, activeValue: string | null | undefined): boolean {
  return storedFacetRowOpen(storedOpen) || !!activeValue;
}

/**
 * What gets persisted: the user's own toggling, and nothing else. An auto-expand must NOT write
 * back — otherwise one visit that happened to arrive with a filter active would silently flip the
 * collapsed-by-default rule for every later visit. Junk or absent values read as collapsed.
 */
export function storedFacetRowOpen(storedOpen: unknown): boolean {
  return typeof storedOpen === "boolean" ? storedOpen : false;
}
