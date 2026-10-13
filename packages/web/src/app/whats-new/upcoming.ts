// "Coming soon" teasers shown at the top of the /whats-new page — features SKILLY_SPEC.md already
// specifies but that have not shipped yet (SKILLY_SPEC.md §23 "Coming soon", and "Implementation
// gaps" at the top of the spec).
//
// MAINTENANCE: every open `⚠ GAP-nn · new feature` marker in SKILLY_SPEC.md must belong to exactly
// one entry here, and every id here must be an open new-feature marker — `upcoming.test.ts` fails
// otherwise. So specifying a feature ahead adds its teaser in the same commit, and the commit that
// ships it deletes the marker AND the teaser (its changelog entry announces it instead).
// COPY: product copy in user terms — no `§`, no GAP ids, no person, skill or namespace named. This
// file is in the client bundle, so a teaser is never confidential, whatever its audience.

export type UpcomingAudience = "everyone" | "admins" | "platform_admin";

export interface UpcomingEntry {
  /** The open new-feature markers this teaser covers (e.g. `["GAP-3", "GAP-4"]`). Never rendered. */
  ids: string[];
  /** Short user-facing feature name. */
  title: string;
  /** One or two plain sentences on what the feature will do for the user. */
  teaser: string;
  audience: UpcomingAudience;
}

/** In display order. Empty while nothing is specified ahead — the section is then hidden. */
export const UPCOMING: UpcomingEntry[] = [
  {
    ids: ["GAP-2"],
    title: "Email digests",
    teaser: "Prefer fewer emails? Get a daily or weekly summary of what you follow instead of one email per update.",
    audience: "everyone",
  },
];

export interface UpcomingViewer {
  isPlatformAdmin: boolean;
  administersNamespace: boolean;
}

/** The entries `viewer` may see, order preserved: `admins` = platform OR namespace admin. */
export function upcomingFor(entries: readonly UpcomingEntry[], viewer: UpcomingViewer): UpcomingEntry[] {
  return entries.filter((e) => {
    if (e.audience === "everyone") return true;
    if (e.audience === "admins") return viewer.isPlatformAdmin || viewer.administersNamespace;
    return viewer.isPlatformAdmin;
  });
}
