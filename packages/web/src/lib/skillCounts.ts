// The Overview's skill tiles (SKILLY_SPEC.md §10): "Skills visible to you", "Hosted", "External".
// Pure and client-safe — the Overview page imports the type, lib/catalog the summing rule.
//
// These are TRUE totals. They come from the catalog's `types` facet (a visibility-filtered COUNT per
// source type, the numbers on the catalog's Source chips), never from the length of a listing:
// `GET /api/skills` is capped (§15), so counting its rows froze the tile at 60.

/** The caller's visible active skills, in total and by source type. */
export interface VisibleSkillCounts {
  total: number;
  hosted: number;
  /** Pointer skills — shown to users as "External". */
  pointer: number;
}

/** Sums a `types` facet into the tiles. A type the viewer sees none of has no facet row ⇒ 0. */
export function skillCountsFromTypes(types: readonly { name: string; count: number }[]): VisibleSkillCounts {
  const of = (name: "hosted" | "pointer") => types.find((t) => t.name === name)?.count ?? 0;
  const hosted = of("hosted");
  const pointer = of("pointer");
  return { total: hosted + pointer, hosted, pointer };
}
