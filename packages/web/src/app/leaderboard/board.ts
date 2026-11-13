// The People board's vocabulary (SKILLY_SPEC.md §21): the row shape, the ranking metrics in toggle
// order, the default sort, the stat line and the avatar slot. Pure, so the order, the wording and
// the sizes are unit-tested without rendering the page.
import { leaderBadgeSize } from "../../components/leaderBadges";
import { ringGeometry } from "../../components/levelRing";

/** The avatar bubble's size on a leaderboard row. */
export const LB_AVATAR = 34;
/** Leader badges shown under a row's avatar before the `+N` marker (§21 "Row layout"): 4, or 2 on
 *  a narrow board so the name gets the width. */
export const LB_MAX_BADGES = 4;
export const LB_MAX_BADGES_COMPACT = 2;
/** §21 "Narrow screens": a board narrower than this (its OWN width, not the window's) lays each
 *  row out in three bands. The desktop columns need about this much to leave the name room. */
export const LB_COMPACT_BELOW = 760;

/** Whether a board `width` px wide uses the three-band rows. */
export function isCompactBoard(width: number): boolean {
  return width < LB_COMPACT_BELOW;
}

/**
 * The fixed avatar slot of a row (§21 "Row layout": every row is the same height): room for a
 * level ring (§31.10) and ONE line of `maxBadges` leader badges plus a `+N` marker, whether or not
 * the person has either. Badge crowns, the Hero crown and the newcomer hat overflow it by design.
 */
export function avatarSlot(maxBadges: number): { width: number; height: number } {
  const badge = leaderBadgeSize(LB_AVATAR);
  const ring = ringGeometry(LB_AVATAR).outer;
  return { width: Math.max(ring, maxBadges * (badge + 2) + 26), height: ring + 2 + badge };
}

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
