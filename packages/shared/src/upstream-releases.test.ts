// Unit tests for the §63 upstream-release rules (SKILLY_SPEC.md §63.13).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bumpLevel,
  classifyPin,
  driftProposeUpdatePath,
  pickCandidate,
  proposalCovers,
  proposeUpdatePath,
  suggestUpstreamVersion,
  upstreamReleaseNotificationContent,
  upstreamReleaseState,
  upstreamSemver,
  upstreamWhatChanged,
  type UpstreamReleaseRow,
} from "./upstream-releases.js";

test("upstreamSemver: a stable semver with an optional leading v; prereleases and other names are not", () => {
  assert.equal(upstreamSemver("v1.2.0"), "1.2.0");
  assert.equal(upstreamSemver("1.2.0"), "1.2.0");
  assert.equal(upstreamSemver("V2.0.0"), "2.0.0");
  assert.equal(upstreamSemver("v2.0.0-beta.1"), null);
  assert.equal(upstreamSemver("main"), null);
  assert.equal(upstreamSemver("release-2024-05"), null);
  assert.equal(upstreamSemver("vv1.2.0"), null);
  assert.equal(upstreamSemver("0123456789abcdef0123456789abcdef01234567"), null);
  assert.equal(upstreamSemver(null), null);
});

test("classifyPin: semver tag, other tag, branch, commit, registry; a tag+branch clash is a tag", () => {
  const refs = { branches: ["main", "v9.9.9-shadow", "both"], tags: ["v1.2.0", "release-2024-05", "both"] };
  assert.equal(classifyPin("v1.2.0", refs, false), "semver_tag");
  assert.equal(classifyPin("release-2024-05", refs, false), "tag");
  assert.equal(classifyPin("main", refs, false), "branch");
  assert.equal(classifyPin("both", refs, false), "tag");
  assert.equal(classifyPin("0123456789abcdef0123456789abcdef01234567", refs, false), "commit");
  assert.equal(classifyPin("gone", refs, false), "commit");
  assert.equal(classifyPin("1.0.0", { branches: [], tags: [] }, true), "registry");
});

test("bumpLevel: the highest component that differs", () => {
  assert.equal(bumpLevel("1.2.3", "2.0.0"), "major");
  assert.equal(bumpLevel("1.2.3", "1.3.0"), "minor");
  assert.equal(bumpLevel("1.2.3", "1.2.4"), "patch");
});

test("pickCandidate: the highest stable semver above the pin, ignoring prereleases and non-semver tags", () => {
  const tags = ["v1.0.0", "v1.2.0", "v1.3.0", "v1.10.0", "v2.0.0-rc.1", "latest", "release-9"];
  assert.deepEqual(pickCandidate("v1.2.0", tags), { ref: "v1.10.0", semver: "1.10.0", bump: "minor" });
  assert.deepEqual(pickCandidate("1.2.0", ["2.0.0", "1.9.0"]), { ref: "2.0.0", semver: "2.0.0", bump: "major" });
  assert.equal(pickCandidate("v1.10.0", tags), null, "nothing higher");
  assert.equal(pickCandidate("main", tags), null, "a branch pin has no newer");
  assert.equal(pickCandidate("v2.0.0-rc.1", tags), null, "a prerelease pin is not ordered");
  assert.deepEqual(pickCandidate("v1.2.0", ["v1.3.0", "1.3.0"]), { ref: "v1.3.0", semver: "1.3.0", bump: "minor" }, "first spelling wins");
});

test("suggestUpstreamVersion: follows the bump above the current latest", () => {
  assert.equal(suggestUpstreamVersion("1.4.2", "major"), "2.0.0");
  assert.equal(suggestUpstreamVersion("1.4.2", "minor"), "1.5.0");
  assert.equal(suggestUpstreamVersion("1.4.2", "patch"), "1.4.3");
  assert.equal(suggestUpstreamVersion("1.4.2", null), "1.4.3", "branch drift ⇒ next patch");
  assert.equal(suggestUpstreamVersion(null, "major"), "1.0.0");
});

const baseRow: UpstreamReleaseRow = {
  originUrl: "https://github.com/acme/skills.git",
  subdir: "pdf",
  pinKind: "semver_tag",
  releaseRef: "v1.3.0",
  releaseSemver: "1.3.0",
  filesChanged: true,
  skippedRef: null,
};
const baseline = { originUrl: "https://github.com/acme/skills", subdir: "/pdf/", ref: "v1.2.0" };
const state = (row: Partial<UpstreamReleaseRow> | null, over: { enabled?: boolean; eligible?: boolean; baseline?: typeof baseline | null } = {}) =>
  upstreamReleaseState({
    enabled: over.enabled ?? true,
    eligible: over.eligible ?? true,
    row: row && { ...baseRow, ...row },
    baseline: over.baseline === undefined ? baseline : over.baseline,
  });

test("upstreamReleaseState: pending when all four conditions hold", () => {
  assert.equal(state({}), "pending", "origin compares normalized, folder without slashes");
  assert.equal(state({ pinKind: "registry", filesChanged: null }), "pending", "registry releases need no folder check");
});

test("upstreamReleaseState: each condition alone turns it off", () => {
  assert.equal(state({}, { enabled: false }), "none", "switch off");
  assert.equal(state({}, { eligible: false }), "none", "deprecated or archived");
  assert.equal(state(null), "none", "never checked");
  assert.equal(state({}, { baseline: null }), "none", "no stable baseline");
  assert.equal(state({ pinKind: "branch" }), "none", "a branch pin has no releases");
  assert.equal(state({ pinKind: "tag" }), "none");
  assert.equal(state({ releaseRef: null, releaseSemver: null }), "none", "no newer release");
  assert.equal(state({}, { baseline: { ...baseline, ref: "v1.3.0" } }), "none", "the update was published");
  assert.equal(state({}, { baseline: { ...baseline, ref: "main" } }), "none", "re-pinned to a branch");
  assert.equal(state({}, { baseline: { ...baseline, originUrl: "https://github.com/fork/skills" } }), "none", "a changed origin");
  assert.equal(state({}, { baseline: { ...baseline, subdir: "docx" } }), "none", "a changed folder");
  assert.equal(state({ filesChanged: false }), "none", "the folder didn't change");
  assert.equal(state({ filesChanged: null }), "none", "the folder check hasn't run");
});

test("upstreamReleaseState: a skip covers its release, and a higher one supersedes it", () => {
  assert.equal(state({ skippedRef: "v1.3.0" }), "skipped");
  assert.equal(state({ skippedRef: "1.3.0" }), "skipped", "spelling doesn't matter");
  assert.equal(state({ skippedRef: "v1.2.5" }), "pending", "a skip of a lower release");
  assert.equal(state({ releaseRef: "v1.4.0", releaseSemver: "1.4.0", skippedRef: "v1.3.0" }), "pending");
});

test("proposalCovers: same source, and a release at or above / the same branch", () => {
  const target = { originUrl: "https://github.com/acme/skills", subdir: "pdf", releaseSemver: "1.3.0" };
  const p = (ref: string, over: Partial<{ originUrl: string; subdir: string | null }> = {}) => ({ originUrl: "git@github.com:acme/skills.git", subdir: "pdf", ref, ...over });
  assert.equal(proposalCovers(p("v1.3.0"), target), true);
  assert.equal(proposalCovers(p("1.4.0"), target), true, "a higher release covers it too");
  assert.equal(proposalCovers(p("v1.2.9"), target), false);
  assert.equal(proposalCovers(p("main"), target), false);
  assert.equal(proposalCovers(p("v1.3.0", { subdir: "docx" }), target), false);
  assert.equal(proposalCovers(p("v1.3.0", { subdir: "//pdf//" }), target), true, "surrounding slashes are ignored");
  assert.equal(proposalCovers(p("v1.3.0", { subdir: `${"/".repeat(100_000)}x` }), target), false, "a long run of slashes is linear");
  assert.equal(proposalCovers(p("v1.3.0", { subdir: "/" }), { ...target, subdir: null }), true, "a lone slash is the repo root");
  assert.equal(proposalCovers(p("v1.3.0", { originUrl: "https://github.com/fork/skills" }), target), false);
  const branch = { originUrl: "https://github.com/acme/skills", subdir: "pdf", branch: "main" };
  assert.equal(proposalCovers(p("main"), branch), true);
  assert.equal(proposalCovers(p("develop"), branch), false);
});

test("links and wording", () => {
  assert.equal(
    proposeUpdatePath({ ns: "team", slug: "pdf", ref: "v1.3.0", kind: "release", bump: "minor" }),
    "/propose?newVersion=1&ns=team&slug=pdf&upstreamRef=v1.3.0&upstreamKind=release&bump=minor",
  );
  assert.equal(proposeUpdatePath({ ns: "team", slug: "pdf", ref: "main", kind: "branch" }), "/propose?newVersion=1&ns=team&slug=pdf&upstreamRef=main&upstreamKind=branch");
  assert.equal(upstreamWhatChanged("release", "v1.2.0", "v1.3.0"), "Updates upstream from v1.2.0 to v1.3.0.");
  assert.equal(upstreamWhatChanged("branch", "main", "main"), "Re-pins main at its latest upstream commit.");

  const c = upstreamReleaseNotificationContent("skill.upstream_release", { namespaceSlug: "team", skillSlug: "pdf", currentRef: "v1.2.0", releaseRef: "v1.3.0", bump: "minor" });
  assert.deepEqual(c, {
    sentence: "team/pdf pins v1.2.0. Upstream has released v1.3.0.",
    ctaLabel: "Propose the update",
    path: "/propose?newVersion=1&ns=team&slug=pdf&upstreamRef=v1.3.0&upstreamKind=release&bump=minor",
  });
  assert.equal(upstreamReleaseNotificationContent("skill.drift", {}), null);

  const drift = { namespaceSlug: "team", skillSlug: "pdf", ref: "main", pinKind: "branch" };
  assert.equal(driftProposeUpdatePath("skill.drift", drift), "/propose?newVersion=1&ns=team&slug=pdf&upstreamRef=main&upstreamKind=branch");
  assert.equal(driftProposeUpdatePath("skill.drift", { ...drift, pinKind: "tag" }), null, "a moved tag gets no button");
  assert.equal(driftProposeUpdatePath("skill.drift", { namespaceSlug: "team", skillSlug: "pdf", ref: "main" }), null, "a pre-§63 drift row");
});
