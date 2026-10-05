// Installed-version freshness (SKILLY_SPEC.md §23 "Installed-version freshness", §39).
//
// An install token is reusable, so an *installation* outlives the clone that created it and can
// silently fall behind the catalog. The gateway stamps `tokens.last_served_semver` on every
// /info/refs advertisement (pinned → pinned_semver; latest-tracking → the stable `main` points at);
// this module turns that stamp plus the skill's current active versions into a derived state.
// Never stored — computed per row at read time, in both the web API and the MCP tool.
//
// Client-safe (`@skilly/shared/freshness`): pure functions, no node deps.
import { compareSemver, isValidSemver, resolveLatest } from "./semver.js";

/**
 * - `current`   — the served version IS the skill's latest stable.
 * - `behind`    — the served version is older than latest stable (pinned-by-choice included —
 *                 the filter answers "what runs old bytes", not "who forgot to update").
 * - `withdrawn` — the served version is yanked / no longer an active version at all. Strictly
 *                 stronger than `behind`; the governance case. Counts as behind for filtering.
 * - `unknown`   — no stamp yet (a pre-0083 latest-tracking install that has not re-cloned, or an
 *                 empty-repo serving), or the skill has no latest stable at all. Never "behind".
 */
export type Freshness = "current" | "behind" | "withdrawn" | "unknown";

export interface FreshnessInput {
  /** `tokens.last_served_semver` — null when never stamped. */
  lastServedSemver: string | null;
  /** The skill's ACTIVE versions (any channel). Yanked versions must NOT be in this list. */
  activeSemvers: readonly string[];
}

export interface FreshnessView {
  freshness: Freshness;
  /** The skill's current latest stable (highest stable active), or null when it has none. */
  latestSemver: string | null;
}

/** Derive the freshness state of one installation (§23). */
export function deriveFreshness({ lastServedSemver, activeSemvers }: FreshnessInput): FreshnessView {
  const latestSemver = resolveLatest(activeSemvers.filter(isValidSemver));
  if (!lastServedSemver || !isValidSemver(lastServedSemver) || !latestSemver) {
    return { freshness: "unknown", latestSemver };
  }
  // A served version that is no longer active (yanked, or deleted outright) is withdrawn —
  // regardless of how it compares to latest.
  if (!activeSemvers.includes(lastServedSemver)) return { freshness: "withdrawn", latestSemver };
  const cmp = compareSemver(lastServedSemver, latestSemver);
  // `current` covers equal AND a pinned beta newer than latest stable (betas never make anything
  // behind, invariant #2). Only strictly-older is behind.
  return { freshness: cmp < 0 ? "behind" : "current", latestSemver };
}

/** True for the states the "Behind latest" filter keeps (§23): behind OR withdrawn. */
export function isBehindLatest(f: Freshness): boolean {
  return f === "behind" || f === "withdrawn";
}

/**
 * How an agent/consumer brings a behind installation forward (§23 "How a consumer refreshes",
 * §29 `list_installed_skills`):
 *   - `rerun`     — a latest-tracking install: re-run the SAME install command already held (or
 *                   `npx skills update`); `main` moved, the token did not. Tokens are hashed at
 *                   rest, so the registry cannot rebuild the command — the holder already has it.
 *   - `reinstall` — a pinned install: mint a NEW install command for `semver` (the new latest);
 *                   the old pinned installation stays listed until it is uninstalled.
 * Null when the row is not behind/withdrawn (nothing to do), or when there is no latest to
 * move to.
 */
export type RefreshHint = { action: "rerun" } | { action: "reinstall"; semver: string };

export function refreshHint(freshness: Freshness, pinned: boolean, latestSemver: string | null): RefreshHint | null {
  if (!isBehindLatest(freshness) || !latestSemver) return null;
  return pinned ? { action: "reinstall", semver: latestSemver } : { action: "rerun" };
}
