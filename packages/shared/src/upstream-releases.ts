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

/** Strip leading and trailing slashes. A loop, not a regex: `\/+$` backtracks polynomially on a
 *  long run of slashes, and folder paths come from proposals (js/polynomial-redos). */
function trimSlashes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === "/") start++;
  while (end > start && s[end - 1] === "/") end--;
  return s.slice(start, end);
}

/** Folder paths compare without surrounding slashes; null and "" are both the repo root. */
function sameFolder(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => trimSlashes((s ?? "").trim());
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
 * The open new-version proposals of the skill at `skillExpr` with their current revision's pointer
 * source (`id`, `url`, `ref`, `subdir`) — the input to `proposalCovers`. A correlated expression
 * (`s.id`) lets the catalog batch it over a page of cards (§63.7).
 */
export function openPointerProposalsSql(skillExpr: string): string {
  return `
  select p.id, pr.payload->'pointer'->>'url' as url, pr.payload->'pointer'->>'ref' as ref,
         pr.payload->'pointer'->>'subdir' as subdir
    from proposals p
    join lateral (
      select payload from proposal_revisions where proposal_id = p.id order by revision_no desc limit 1
    ) pr on true
   where p.target_skill_id = ${skillExpr} and p.state in ('proposed', 'under_review', 'changes_requested')
   order by p.created_at desc`;
}

/** `openPointerProposalsSql` for skill `$1`, shared by the sweep and the page. */
export const OPEN_POINTER_PROPOSALS_SQL = openPointerProposalsSql("$1");

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

/** An open proposal's pointer source with its id — one row of `openPointerProposalsSql`. */
export interface OpenProposalPointer extends ProposalPointer {
  id: string;
}

/** The first open proposal that covers the target (§63.5, §63.6), or null. */
function coveringProposalId(
  proposals: OpenProposalPointer[],
  target: { originUrl: string; subdir: string | null; releaseSemver?: string | null; branch?: string | null },
): string | null {
  return proposals.find((p) => proposalCovers(p, target))?.id ?? null;
}

/** What the skill page notice shows (§63.7), before the UI dresses it. */
export type UpstreamNotice =
  | { kind: "release"; state: "pending"; proposalId: string | null }
  | { kind: "release"; state: "skipped" }
  | { kind: "branch_drift"; proposalId: string | null };

/** Everything the notice and the catalog pill are derived from, for one skill. */
export interface UpstreamNoticeInput {
  /** The `upstream_releases_enabled` switch (§63.10). */
  enabled: boolean;
  /** `skills.status = 'active'`. */
  active: boolean;
  deprecated: boolean;
  /** The sweep's row, plus the baseline it last ran against and the stored bump. */
  row: (UpstreamReleaseRow & { baselineVersionId: string; releaseBump: string | null }) | null;
  /** The CURRENT baseline (§63.2) with its version id and semver; null for a hosted skill. */
  baseline: (UpstreamBaseline & { id: string; semver: string }) | null;
  /** The baseline's most recent pointer_ref report, ignoring unreachable blips, is a drift (§63.6). */
  baselineDrifted: boolean;
  openProposals: OpenProposalPointer[];
}

/**
 * The skill page notice (§63.7), or null. A pending or skipped release wins; otherwise branch drift
 * on THIS baseline. Branch drift is not gated by the switch or by deprecation (§63.6).
 */
export function upstreamNotice(input: UpstreamNoticeInput): UpstreamNotice | null {
  const { row, baseline } = input;
  if (!input.active || !row || !baseline) return null;
  const state = upstreamReleaseState({ enabled: input.enabled, eligible: !input.deprecated, row, baseline });
  if (state === "skipped") return { kind: "release", state: "skipped" };
  if (state === "pending") {
    const target = { originUrl: baseline.originUrl, subdir: baseline.subdir, releaseSemver: row.releaseSemver };
    return { kind: "release", state: "pending", proposalId: coveringProposalId(input.openProposals, target) };
  }
  if (row.pinKind === "branch" && row.baselineVersionId === baseline.id && input.baselineDrifted) {
    const target = { originUrl: baseline.originUrl, subdir: baseline.subdir, branch: baseline.ref };
    return { kind: "branch_drift", proposalId: coveringProposalId(input.openProposals, target) };
  }
  return null;
}

/** The catalog pill's two states (§63.7): nobody has acted yet, or a proposal already covers it. */
export type UpstreamPillState = "available" | "proposed";

/** The `upstreamUpdate` field of a catalog card (§63.11). */
export interface UpstreamCardUpdate {
  state: UpstreamPillState;
  kind: "release" | "branch_drift";
  /** The baseline's pinned ref (the branch name, for branch drift). */
  currentRef: string;
  baselineSemver: string;
  releaseRef?: string;
  bump?: UpstreamBump | null;
}

/**
 * The catalog pill (§63.1 decisions 14 and 17): `available` when the notice offers *Propose the
 * update*, `proposed` when it offers *View the proposal*, and none for a skipped release or a
 * deprecated skill. The audience (effective maintainers and platform admins) is the caller's call.
 */
export function upstreamCardUpdate(input: UpstreamNoticeInput): UpstreamCardUpdate | null {
  const notice = upstreamNotice(input);
  const { row, baseline } = input;
  if (!notice || input.deprecated || !row || !baseline) return null;
  if (notice.kind === "release" && notice.state === "skipped") return null;
  const base = { state: notice.proposalId ? "proposed" : "available", currentRef: baseline.ref, baselineSemver: baseline.semver } as const;
  if (notice.kind === "branch_drift") return { ...base, kind: "branch_drift" };
  return { ...base, kind: "release", releaseRef: row.releaseRef ?? "", bump: isUpstreamBump(row.releaseBump) ? row.releaseBump : null };
}

/** The pill's text (§63.7). */
export function upstreamPillLabel(u: Pick<UpstreamCardUpdate, "state">): string {
  return u.state === "available" ? "update available" : "update proposed";
}

/** The pill's tooltip and accessible name (§63.7). */
export function upstreamPillTitle(u: UpstreamCardUpdate): string {
  if (u.kind === "branch_drift") {
    return u.state === "available"
      ? `Upstream ${u.currentRef} has moved since v${u.baselineSemver} was pinned.`
      : `Upstream ${u.currentRef} has moved. An update is already proposed.`;
  }
  if (u.state === "proposed") return `Upstream ${u.releaseRef} is out. An update is already proposed.`;
  return `Upstream ${u.releaseRef} is out. This skill pins ${u.currentRef}${u.bump ? ` (${u.bump} update)` : ""}.`;
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
