// Which e2e specs may run in parallel with which (SKILLY_SPEC.md §16 item 18).
//
// The Jenkins run (ci/e2e-run.sh) drives several Playwright workers against ONE database and ONE dev
// server, so a spec may run alongside another only when it cannot see that spec's state. Every spec
// file in this folder is classified here exactly once (groups.test.ts fails otherwise), into one of:
//
//   EXCLUSIVE  changes state EVERY other spec can observe, not scoped to its own user or fixtures:
//              platform settings, the AI integration config (it switches pre-review on for every
//              proposal), the email wrapper, role mappings, search synonyms, policy rules, a SEEDED
//              skill's featured/deprecated state, the shared seeded `team-a` namespace's settings.
//              One project, one worker, run as phase 1 with nothing else alongside.
//   GROUPS     share mutable state with each other but with nothing outside the group. Each group is
//              one project with one worker: its files run one after another, in the (alphabetical)
//              order listed, which is the order Playwright collects them in. Groups run alongside
//              each other and the parallel class in phase 2.
//   PARALLEL   read-only, or touching only their own uniquely named fixtures and their own user's
//              state (each worker signs in as its own user — fixtures.ts). Fully parallel.
//
// Serial files (`test.describe.serial`, `mode: "serial"`) keep their in-file order in any class.
// When in doubt, a spec moves toward the stricter class (parallel → a group → exclusive), with the
// reason next to it. A spec that signs in as the dev admin (`devSignIn(page, { as: "dev-admin" })`)
// belongs in the `dev-admin` group.

/** Phase 1: one worker, alone. */
export const EXCLUSIVE: readonly string[] = [
  "admin-crud.spec.ts", // role mappings: RBAC for every user
  "ai-draft.spec.ts", // AI integration config
  "ai-integration.spec.ts", // AI integration config + timeouts
  "ai-prereview.spec.ts", // AI pre-review on proposals
  "ai-quality-draft.spec.ts", // AI integration config
  "chunked-upload.spec.ts", // platform settings: chunked upload switch (every upload)
  "deprecation.spec.ts", // deprecates the seeded global/lint-fixer
  "email-digests.spec.ts", // platform settings: digest switch and defaults
  "email-notifications.spec.ts", // the platform email wrapper (Administration card)
  "feature-ideas.spec.ts", // a published idea changes Coming soon for every user; the feature switch
  "featured-skills.spec.ts", // features the seeded global/pdf-tools on the home page
  "hype.spec.ts", // platform settings: hype switch
  "maintainer-contact.spec.ts", // team-a namespace settings
  "marketplaces-directory.spec.ts", // team-a namespace settings
  "mcp-connect.spec.ts", // platform settings: MCP switch
  "namespace-switches.spec.ts", // team-a namespace settings (require_review and friends)
  "policy.spec.ts", // policy rules apply to every proposal
  "quality.spec.ts", // AI integration config
  "rum.spec.ts", // platform settings: RUM switch; the shared rum_daily rollup
  "search-fts.spec.ts", // search synonyms: every catalog search
  "survey.spec.ts", // platform settings: survey + bug-report switches
];

/** Phase 2: each group one worker, files in the order listed (keep each list alphabetical). */
export const GROUPS: Readonly<Record<string, { shares: string; specs: readonly string[] }>> = {
  "dev-admin": {
    shares: "the seeded dev admin's own data (directory profile, profile opt-outs)",
    specs: ["directory-hover-card.spec.ts"],
  },
  discussion: {
    shares: "discussion threads on the seeded skills",
    specs: ["discussion-replies.spec.ts", "mentions.spec.ts", "skill-discussion.spec.ts"],
  },
  installs: {
    shares: "the seeded skills' install counts and the install leaderboard",
    specs: [
      "already-installed.spec.ts",
      "install-command.spec.ts",
      "installed-freshness.spec.ts",
      "installed-search.spec.ts",
      "leaderboard.spec.ts",
    ],
  },
  proposals: {
    shares: "the review queue",
    specs: [
      "card-geometry.spec.ts",
      "content-risk.spec.ts",
      "icon.spec.ts",
      "namespace-sharing.spec.ts", // stricter than the spec's starting table: accepts proposals
      "proposal-revise.spec.ts",
      "propose-review-publish.spec.ts",
    ],
  },
  requests: {
    shares: "the requests board and its counts",
    specs: [
      "category-collapse.spec.ts",
      "leaderboard-requested.spec.ts",
      "requests-lifecycle.spec.ts",
      "requests-search.spec.ts",
    ],
  },
};

/** Phase 2: fully parallel. */
export const PARALLEL: readonly string[] = [
  "access-gating.spec.ts",
  "achievements.spec.ts",
  "active-users-chart.spec.ts",
  "admin-collapsible-cards.spec.ts",
  "all-routes-smoke.spec.ts",
  "collections.spec.ts",
  "dropdown-dismiss.spec.ts",
  "follow.spec.ts",
  "header-search-clear.spec.ts",
  "last-watched-card.spec.ts",
  "new-version-metadata.spec.ts",
  "notifications.spec.ts",
  "quick-start.spec.ts",
  "skill-detail.spec.ts",
  "slug-match-redirect.spec.ts",
  "smoke.spec.ts",
  "usage-analytics.spec.ts",
  "usage-header-search.spec.ts",
  "whats-new-coming-soon.spec.ts",
  "whats-new-notice.spec.ts",
];

/** The Playwright project names, and which spec files each runs. */
export const EXCLUSIVE_PROJECT = "exclusive";
export const PARALLEL_PROJECT = "parallel";
export const groupProject = (name: string) => `group-${name}`;
