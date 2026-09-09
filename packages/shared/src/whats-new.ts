// What's new — the once-per-release toast rule and its helpers (SKILLY_SPEC.md §23, "What's new").
// Pure functions, client-safe (subpath export `@skilly/shared/whats-new`): the app shell decides
// whether to show the "Version X updated — see what's new" toast, the stamp endpoint validates the
// version a client claims to have seen, and the What's new page splits its timeline at the
// "New since your last visit" divider. All three live here so client and server share one rule.
import { parseSemver, compareSemver } from "./semver.js";

export type WhatsNewAction = "toast" | "advance" | "none";

/**
 * What the app shell should do once `/api/me` resolves, given the user's stored marker (`seen`,
 * null = never stamped), the CLIENT bundle's `APP_VERSION` (`current`), and whether the user has
 * completed Quick start (`onboarded`).
 *
 *  - "none"    — not onboarded (the Quick start gate owns this load and stamps the marker itself),
 *                `current` isn't a valid semver, or `seen` is not lower than `current` (a rollback
 *                or a stale cached bundle never shows anything and never touches the marker).
 *  - "toast"   — never stamped, or stamped at a version whose MAJOR or MINOR differs from `current`.
 *  - "advance" — stamped lower, but only the PATCH differs: move the marker forward silently.
 *
 * A stored value that isn't valid semver (corrupt) is treated as never stamped.
 */
export function whatsNewAction(seen: string | null | undefined, current: string, onboarded: boolean): WhatsNewAction {
  if (!onboarded) return "none";
  const cur = parseSemver(current);
  if (!cur) return "none";
  if (seen == null) return "toast";
  const prev = parseSemver(seen);
  if (!prev) return "toast";
  if (compareSemver(current, seen) <= 0) return "none";
  return prev.major !== cur.major || prev.minor !== cur.minor ? "toast" : "advance";
}

/**
 * Validate the version a client claims to have seen. Returns the trimmed version, or null when it
 * is not a string, not a valid semver, or GREATER than the server's running version (a client
 * cannot claim the future). Equal is fine — that is the normal case.
 */
export function validateSeenVersion(version: unknown, serverVersion: string): string | null {
  if (typeof version !== "string") return null;
  const v = version.trim();
  if (!parseSemver(v) || !parseSemver(serverVersion)) return null;
  return compareSemver(v, serverVersion) > 0 ? null : v;
}

/**
 * How many leading entries of a newest-first changelog are "new since your last visit": the count
 * of versions strictly greater than `since`. 0 (no divider) when `since` is missing, invalid, or
 * not lower than `current`. Entries with an unparsable version never count as new.
 */
export function countNewSince(versionsNewestFirst: readonly string[], since: string | null | undefined, current: string): number {
  if (since == null) return 0;
  const s = since.trim();
  if (!parseSemver(s) || !parseSemver(current) || compareSemver(s, current) >= 0) return 0;
  let n = 0;
  for (const v of versionsNewestFirst) {
    if (parseSemver(v) && compareSemver(v, s) > 0) n++;
  }
  return n;
}
