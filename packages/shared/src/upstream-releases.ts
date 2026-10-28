// Upstream release alerts (SKILLY_SPEC.md §63) — the pure rules the worker sweep, the web detail
// API, the propose form and both notification renderers share: which upstream refs are releases,
// the candidate and its bump level, the suggested skilly version, the baseline's pin kind, whether a
// release is pending, which open proposal covers it, and the notification wording and links.
// Client-safe (no node deps); exported via the barrel and the `@skilly/shared/upstream-releases`
// subpath.
import { compareSemver, parseSemver } from "./semver.js";
import { normalizeOriginUrl } from "./external-tool.js";

/** The platform switch (§63.10). Absent ⇒ on. */
export const UPSTREAM_RELEASES_SETTING_KEY = "upstream_releases_enabled";

export type UpstreamPinKind = "semver_tag" | "tag" | "branch" | "commit" | "registry";
export type UpstreamBump = "major" | "minor" | "patch";
export type UpstreamKind = "release" | "branch";

export function isUpstreamBump(v: unknown): v is UpstreamBump {
  return v === "major" || v === "minor" || v === "patch";
}

/**
 * The stable semver a ref names, or null. One leading `v` is tolerated (`v1.2.0` → `1.2.0`);
 * prereleases are never releases (§63.1 decision 1), and anything else (`main`, `release-2024-05`, a
 * SHA) is not a version.
 */
export function upstreamSemver(ref: string | null | undefined): string | null {
  const raw = (ref ?? "").trim().replace(/^v/i, "");
  const p = parseSemver(raw);
  if (!p || p.prerelease.length > 0) return null;
  return raw;
}

/**
 * The baseline's pin kind (§63.2), from the origin's listing. A name that is both a tag and a branch
 * counts as a tag, so it never gets the drift button.
 */
export function classifyPin(
  ref: string,
  refs: { branches: Iterable<string>; tags: Iterable<string> },
  registry: boolean,
): UpstreamPinKind {
  if (registry) return "registry";
  if (new Set(refs.tags).has(ref)) return upstreamSemver(ref) ? "semver_tag" : "tag";
  if (new Set(refs.branches).has(ref)) return "branch";
  return "commit";
}

/** The highest semver component that differs between `from` and `to` (both stable semvers). */
export function bumpLevel(from: string, to: string): UpstreamBump {
  const a = parseSemver(from);
  const b = parseSemver(to);
  if (!a || !b) return "patch";
  if (a.major !== b.major) return "major";
  if (a.minor !== b.minor) return "minor";
  return "patch";
}

export interface UpstreamCandidate {
  /** As upstream spells it (`v1.3.0`, `1.3.0`). */
  ref: string;
  semver: string;
  bump: UpstreamBump;
}

/**
 * The candidate release (§63.3): the highest stable semver among `refs` that is above the pinned
 * ref's. Null when the pin isn't a semver, or nothing upstream is higher. Of two spellings of one
 * version (`v1.3.0` and `1.3.0`) the first listed wins.
 */
export function pickCandidate(pinnedRef: string, refs: Iterable<string>): UpstreamCandidate | null {
  const pinned = upstreamSemver(pinnedRef);
  if (!pinned) return null;
  let best: { ref: string; semver: string } | null = null;
  for (const ref of refs) {
    const semver = upstreamSemver(ref);
    if (!semver || compareSemver(semver, pinned) <= 0) continue;
    if (!best || compareSemver(semver, best.semver) > 0) best = { ref, semver };
  }
  return best && { ...best, bump: bumpLevel(pinned, best.semver) };
}

/**
 * The version the pre-filled propose form suggests (§63.1 decision 6): the next `bump` above the
 * skill's current latest stable. No bump (branch drift, a bad parameter) ⇒ the next patch; no
 * latest ⇒ `1.0.0`, the form's own default.
 */
export function suggestUpstreamVersion(latest: string | null | undefined, bump: UpstreamBump | null | undefined): string {
  const p = latest ? parseSemver(latest) : null;
  if (!p) return "1.0.0";
  if (bump === "major") return `${p.major + 1}.0.0`;
  if (bump === "minor") return `${p.major}.${p.minor + 1}.0`;
  return `${p.major}.${p.minor}.${p.patch + 1}`;
}

/** Folder paths compare without surrounding slashes; null and "" are both the repo root. */
function sameFolder(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => (s ?? "").trim().replace(/^\/+|\/+$/g, "");
  return norm(a) === norm(b);
}

/** Same upstream source: the normalized origin URL and the folder inside it. */
export function sameUpstreamSource(
  a: { originUrl: string; subdir: string | null | undefined },
  b: { originUrl: string; subdir: string | null | undefined },
): boolean {
  return normalizeOriginUrl(a.originUrl) === normalizeOriginUrl(b.originUrl) && sameFolder(a.subdir, b.subdir);
}

/** The sweep's stored state for one skill (`skill_upstream_releases`). */
export interface UpstreamReleaseRow {
  originUrl: string;
  subdir: string | null;
  pinKind: UpstreamPinKind;
  releaseRef: string | null;
  releaseSemver: string | null;
  filesChanged: boolean | null;
  skippedRef: string | null;
}

/** The skill's current baseline: its latest stable active version's pin. */
export interface UpstreamBaseline {
  originUrl: string;
  subdir: string | null;
  ref: string;
}

/** Is the stored release pending, apart from the skip (§63.4 conditions 1–3)? */
function releaseApplies(enabled: boolean, eligible: boolean, row: UpstreamReleaseRow, baseline: UpstreamBaseline): boolean {
  if (!enabled || !eligible) return false;
  if (row.pinKind !== "semver_tag" && row.pinKind !== "registry") return false;
  if (!row.releaseRef || !row.releaseSemver || !parseSemver(row.releaseSemver)) return false;
  if (!sameUpstreamSource(row, baseline)) return false;
  const pinned = upstreamSemver(baseline.ref);
  if (!pinned || compareSemver(row.releaseSemver, pinned) <= 0) return false;
  if (row.pinKind === "semver_tag" && row.filesChanged !== true) return false;
  return true;
}

/** Does the skip cover the stored release? A higher release supersedes it (§63.8). */
function skipCovers(row: UpstreamReleaseRow): boolean {
  const skipped = upstreamSemver(row.skippedRef);
  if (!skipped || !row.releaseSemver) return false;
  return compareSemver(row.releaseSemver, skipped) <= 0;
}

export type UpstreamReleaseState = "none" | "pending" | "skipped";

/**
 * The release state on read (§63.4): `pending` when all four conditions hold, `skipped` when only the
 * skip stands in the way, else `none`. Evaluated against the CURRENT baseline, so publishing the
 * update clears it at once.
 */
export function upstreamReleaseState(input: {
  enabled: boolean;
  eligible: boolean;
  row: UpstreamReleaseRow | null;
  baseline: UpstreamBaseline | null;
}): UpstreamReleaseState {
  const { row, baseline } = input;
  if (!row || !baseline || !releaseApplies(input.enabled, input.eligible, row, baseline)) return "none";
  return skipCovers(row) ? "skipped" : "pending";
}

/**
 * The open new-version proposals of skill `$1` with their current revision's pointer source
 * (`id`, `url`, `ref`, `subdir`) — the input to `proposalCovers`, shared by the sweep and the page.
 */
export const OPEN_POINTER_PROPOSALS_SQL = `
  select p.id, pr.payload->'pointer'->>'url' as url, pr.payload->'pointer'->>'ref' as ref,
         pr.payload->'pointer'->>'subdir' as subdir
    from proposals p
    join lateral (
      select payload from proposal_revisions where proposal_id = p.id order by revision_no desc limit 1
    ) pr on true
   where p.target_skill_id = $1 and p.state in ('proposed', 'under_review', 'changes_requested')
   order by p.created_at desc`;

/** An open proposal's pointer source, as its current revision carries it. */
export interface ProposalPointer {
  originUrl: string;
  subdir: string | null;
  ref: string;
}

/**
 * Does an open proposal cover the release or the branch re-pin (§63.5, §63.6)? Same origin and
 * folder, and either a stable semver at or above the release, or the same branch name.
 */
export function proposalCovers(
  proposal: ProposalPointer,
  target: { originUrl: string; subdir: string | null; releaseSemver?: string | null; branch?: string | null },
): boolean {
  if (!sameUpstreamSource(proposal, target)) return false;
  if (target.branch) return proposal.ref.trim() === target.branch;
  const proposed = upstreamSemver(proposal.ref);
  return !!proposed && !!target.releaseSemver && compareSemver(proposed, target.releaseSemver) >= 0;
}

/** The pre-filled propose form's link (§63.9). */
export function proposeUpdatePath(input: { ns: string; slug: string; ref: string; kind: UpstreamKind; bump?: UpstreamBump | null }): string {
  const q = new URLSearchParams({ newVersion: "1", ns: input.ns, slug: input.slug, upstreamRef: input.ref, upstreamKind: input.kind });
  if (input.kind === "release" && input.bump) q.set("bump", input.bump);
  return `/propose?${q.toString()}`;
}

/** The pre-filled *What changed* note (§63.9). */
export function upstreamWhatChanged(kind: UpstreamKind, currentRef: string | null, ref: string): string {
  if (kind === "branch") return `Re-pins ${ref} at its latest upstream commit.`;
  return currentRef ? `Updates upstream from ${currentRef} to ${ref}.` : `Updates upstream to ${ref}.`;
}

export interface UpstreamNotificationContent {
  sentence: string;
  ctaLabel: string;
  path: string;
}

/**
 * The §63.5 wording of `skill.upstream_release`, shared by the in-app inbox, the email renderer and
 * the digest. Payload keys: `namespaceSlug`, `skillSlug`, `currentRef`, `releaseRef`, `bump`. Null
 * for any other type.
 */
export function upstreamReleaseNotificationContent(type: string, payload: Record<string, unknown>): UpstreamNotificationContent | null {
  if (type !== "skill.upstream_release") return null;
  const ns = typeof payload.namespaceSlug === "string" ? payload.namespaceSlug : "";
  const slug = typeof payload.skillSlug === "string" ? payload.skillSlug : "";
  const currentRef = typeof payload.currentRef === "string" ? payload.currentRef : "";
  const releaseRef = typeof payload.releaseRef === "string" ? payload.releaseRef : "";
  return {
    sentence: `${ns}/${slug} pins ${currentRef}. Upstream has released ${releaseRef}.`,
    ctaLabel: "Propose the update",
    path: proposeUpdatePath({ ns, slug, ref: releaseRef, kind: "release", bump: isUpstreamBump(payload.bump) ? payload.bump : null }),
  };
}

/**
 * The second CTA of a `skill.drift` row on a branch-pinned baseline (§63.6), or null — any other
 * drift (a moved tag or commit, an older version) keeps no button.
 */
export function driftProposeUpdatePath(type: string, payload: Record<string, unknown>): string | null {
  if (type !== "skill.drift" || payload.pinKind !== "branch") return null;
  const ns = typeof payload.namespaceSlug === "string" ? payload.namespaceSlug : null;
  const slug = typeof payload.skillSlug === "string" ? payload.skillSlug : null;
  const ref = typeof payload.ref === "string" ? payload.ref : null;
  if (!ns || !slug || !ref) return null;
  return proposeUpdatePath({ ns, slug, ref, kind: "branch" });
}
