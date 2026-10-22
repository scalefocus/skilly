// The spec ⇄ "Coming soon" consistency check (SKILLY_SPEC.md §23 "Coming soon"). Pure — the unit
// test feeds it the real SKILLY_SPEC.md text plus fixture strings. Not imported by the page.
import { isUpcomingKey } from "@skilly/shared/ideas";
import type { UpcomingEntry } from "./upcoming";

export type GapKind = "new feature" | "code fix";

/** Only the literal `⚠ GAP-<digits> · new feature|code fix` is a marker — `GAP-nn` placeholders
 *  and bare ids quoted as examples never are. */
const MARKER = /⚠ GAP-(\d+) · (new feature|code fix)/g;

export function parseGapMarkers(spec: string): { id: string; kind: GapKind }[] {
  return [...spec.matchAll(MARKER)].map((m) => ({ id: `GAP-${m[1]}`, kind: m[2] as GapKind }));
}

/** Every way `entries` and the spec's markers disagree, as human-readable problems ([] = in step). */
export function upcomingProblems(spec: string, entries: readonly UpcomingEntry[]): string[] {
  const problems: string[] = [];
  const markers = parseGapMarkers(spec);

  const seen = new Set<string>();
  for (const m of markers) {
    if (seen.has(m.id)) problems.push(`${m.id} appears in more than one marker`);
    seen.add(m.id);
  }
  const openFeatures = new Set(markers.filter((m) => m.kind === "new feature").map((m) => m.id));

  const owners = new Map<string, number>();
  const keys = new Set<string>();
  entries.forEach((e, i) => {
    const label = `UPCOMING[${i}] "${e.title}"`;
    if (e.ids.length === 0) problems.push(`${label} has no ids`);
    // §60.3 the vote key: present, kebab-case, ≤ 60 characters, unique.
    if (!isUpcomingKey(e.key)) problems.push(`${label} has a missing or malformed key`);
    else if (keys.has(e.key)) problems.push(`${label} reuses the key "${e.key}"`);
    else keys.add(e.key);
    for (const id of e.ids) {
      if (!openFeatures.has(id)) problems.push(`${label} lists ${id}, which is not an open new-feature marker`);
      owners.set(id, (owners.get(id) ?? 0) + 1);
    }
    for (const [field, text] of [["title", e.title], ["teaser", e.teaser]] as const) {
      if (!text.trim()) problems.push(`${label} has an empty ${field}`);
      if (text.includes("§") || text.includes("GAP-")) problems.push(`${label} ${field} mentions a spec section or GAP id`);
    }
  });

  for (const id of openFeatures) {
    const n = owners.get(id) ?? 0;
    if (n === 0) problems.push(`${id} is an open new-feature marker with no UPCOMING entry`);
    if (n > 1) problems.push(`${id} belongs to ${n} UPCOMING entries`);
  }
  return problems;
}
