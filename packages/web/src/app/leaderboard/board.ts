// The People board's vocabulary (SKILLY_SPEC.md §21): the row shape, the ranking metrics in toggle
// order, the default sort and the stat line. Pure, so the order and the wording are unit-tested
// without rendering the page.

export interface Entry {
  userId: string;
  displayName: string;
  email: string;
  avatar: string | null;
  skillCount: number;
  installs: number;
  requestsFulfilled: number;
  skillsWatched: number;
  skillsRequested: number;
  /** Active followers (§35.7) — 0 while the person has paused follows. */
  followers: number;
  /** Collections holding at least 3 eligible skills (§38.8). */
  collections: number;
  /** Skills this person installed themselves, one per skill (§21 "Skills installed"). */
  skillsInstalled: number;
  followable: boolean;
}

export type Sort = "installs" | "skills" | "requests" | "watched" | "requested" | "followed" | "curated" | "installed";

// The ranking metrics, in toggle order (§21/§26/§35.7/§38.8): the button label, the caption under
// the row's big number, and the number itself. `installed` is the person's OWN installs and leads
// the toggle; `installs` counts OTHER people's first installs of the skills someone maintains,
// hence the button "Installs received". Captions stay one short word so the name column keeps its
// width (§21 "Row layout").
export const SORTS: { key: Sort; label: string; caption: string; value: (e: Entry) => number }[] = [
  { key: "installed", label: "Installed", caption: "installed", value: (e) => e.skillsInstalled },
  { key: "installs", label: "Installs received", caption: "installs", value: (e) => e.installs },
  { key: "skills", label: "Skills adopted", caption: "adopted", value: (e) => e.skillCount },
  { key: "requests", label: "Requests fulfilled", caption: "fulfilled", value: (e) => e.requestsFulfilled },
  { key: "watched", label: "Watched", caption: "watched", value: (e) => e.skillsWatched },
  { key: "requested", label: "Requested", caption: "requested", value: (e) => e.skillsRequested },
  { key: "followed", label: "Followed", caption: "followers", value: (e) => e.followers },
  { key: "curated", label: "Curated", caption: "collections", value: (e) => e.collections },
];

/** What `/leaderboard` opens on (§21 "Sort and row"): the number people expect to see move when
 *  they install a skill. The page's choice only — the API's own fallback stays `installs`. */
export const DEFAULT_SORT: Sort = "installed";

/** The stat line under a name, as one string so it can also be the hover text when it is cut. It
 *  starts with skills installed (when above zero) so the headline number is never the part cut
 *  off; "skills adopted" always shows; the rest only when above zero. */
export function statLine(e: Entry): string {
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  const parts: string[] = [];
  if (e.skillsInstalled > 0) parts.push(`${n(e.skillsInstalled, "skill")} installed`);
  parts.push(`${n(e.skillCount, "skill")} adopted`);
  if (e.requestsFulfilled > 0) parts.push(`${n(e.requestsFulfilled, "request")} fulfilled`);
  if (e.skillsWatched > 0) parts.push(`${n(e.skillsWatched, "skill")} watched`);
  if (e.skillsRequested > 0) parts.push(`${n(e.skillsRequested, "skill")} requested`);
  if (e.followers > 0) parts.push(n(e.followers, "follower"));
  if (e.collections > 0) parts.push(n(e.collections, "collection"));
  return parts.join(" · ");
}
