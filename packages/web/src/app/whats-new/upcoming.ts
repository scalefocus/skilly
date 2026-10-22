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
    ids: ["GAP-4"],
    title: "Skill evals",
    teaser: "Skills can ship their own test cases. Each new version is checked against them, so reviewers see what passes and what got worse.",
    audience: "everyone",
  },
  {
    ids: ["GAP-5"],
    title: "Upstream release alerts",
    teaser: "If you maintain a skill that points at another repository, you'll hear when a newer release is out and can propose the update in one click.",
    audience: "everyone",
  },
  {
    ids: ["GAP-6"],
    title: "Try a skill before installing",
    teaser: "Chat with the AI assistant with a skill loaded, right from its page, to see how it behaves before you install it.",
    audience: "everyone",
  },
  {
    ids: ["GAP-7"],
    title: "Review assignments and deadlines",
    teaser: "Assign proposals to a reviewer, set a review target for your namespace, and get reminders when proposals wait too long.",
    audience: "admins",
  },
  {
    ids: ["GAP-8"],
    title: "Search gaps",
    teaser: "See what people search for and don't find, with no one's identity attached, and turn it into a synonym or a skill request.",
    audience: "admins",
  },
  {
    ids: ["GAP-9"],
    title: "Popular in your department",
    teaser: "A home-page row of the skills colleagues in your department are adopting.",
    audience: "everyone",
  },
  {
    ids: ["GAP-10"],
    title: "Customize a skill for your team",
    teaser: "Make your own copy of a skill for your team, keep a link to the original, and hear when the original changes.",
    audience: "everyone",
  },
  {
    ids: ["GAP-11"],
    title: "Import a whole repository",
    teaser: "Point at a repository full of skills, tick the ones you want, and propose them all in one go.",
    audience: "everyone",
  },
  {
    ids: ["GAP-12"],
    title: "Usage insights",
    teaser: "Opt-in reporting from the plugin marketplaces, so maintainers see how often a skill is actually used, not just installed.",
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
