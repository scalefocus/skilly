// §70.8 relocation of a moved skill's serving repo — real directories, real `git` synthesis.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthesizeVersion, listTags } from "./synth.js";
import { repoPath, repoProvisioned, pickServedRepo, rewriteRepoPathInfo } from "./repoStore.js";
import { relocateMovedRepos, relocateOne, type AliasRepoRow } from "./relocate.js";

const enc = (s: string) => new TextEncoder().encode(s);
let root: string;

const exists = async (p: string) => access(p).then(() => true, () => false);
const synth = (ns: string, slug: string, semver: string) =>
  synthesizeVersion({ bareRepoPath: repoPath(root, ns, slug), semver, isLatestStable: true, files: [{ path: "SKILL.md", bytes: enc(`# ${slug} ${semver}\n`) }] });

before(async () => {
  root = await mkdtemp(join(tmpdir(), "skilly-relocate-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("renames the old directory to the canonical address, keeping every tag", async () => {
  await synth("team-a", "moved", "1.0.0");
  await synth("team-a", "moved", "1.1.0");
  const row: AliasRepoRow = { alias_ns_slug: "team-a", alias_slug: "moved", ns_slug: "team-b", skill_slug: "moved" };
  assert.equal(await relocateOne(root, row), "renamed");
  assert.equal(await exists(repoPath(root, "team-a", "moved")), false);
  assert.ok(await repoProvisioned(root, "team-b", "moved"));
  assert.deepEqual((await listTags(repoPath(root, "team-b", "moved"))).sort(), ["v1.0.0", "v1.1.0"]);
  // Idempotent: nothing left to do.
  assert.equal(await relocateOne(root, row), "none");
});

test("both directories present: the stale old one goes once the canonical one is provisioned", async () => {
  await synth("team-c", "both", "1.0.0");
  await synth("team-d", "both", "1.0.0");
  const row: AliasRepoRow = { alias_ns_slug: "team-c", alias_slug: "both", ns_slug: "team-d", skill_slug: "both" };
  assert.equal(await relocateOne(root, row), "removed");
  assert.equal(await exists(repoPath(root, "team-c", "both")), false);
  assert.ok(await repoProvisioned(root, "team-d", "both"));
});

test("a canonical directory that can't serve yet keeps the old one", async () => {
  await synth("team-e", "half", "1.0.0");
  // An init'd-but-empty canonical repo (no refs) is not provisioned.
  const { mkdir, writeFile } = await import("node:fs/promises");
  const empty = repoPath(root, "team-f", "half");
  await mkdir(empty, { recursive: true });
  await writeFile(join(empty, "HEAD"), "ref: refs/heads/main\n");
  const row: AliasRepoRow = { alias_ns_slug: "team-e", alias_slug: "half", ns_slug: "team-f", skill_slug: "half" };
  assert.equal(await relocateOne(root, row), "none");
  assert.ok(await repoProvisioned(root, "team-e", "half"));
});

test("no old directory, or an unsafe slug: nothing happens", async () => {
  assert.equal(await relocateOne(root, { alias_ns_slug: "ghost", alias_slug: "none", ns_slug: "team-x", skill_slug: "none" }), "none");
  assert.equal(await relocateOne(root, { alias_ns_slug: "..", alias_slug: "x", ns_slug: "team-x", skill_slug: "x" }), "none");
});

test("relocateMovedRepos walks every alias row and counts what it changed", async () => {
  await synth("team-g", "swept", "2.0.0");
  const rows: AliasRepoRow[] = [
    { alias_ns_slug: "team-g", alias_slug: "swept", ns_slug: "team-h", skill_slug: "swept" },
    { alias_ns_slug: "nowhere", alias_slug: "swept", ns_slug: "team-h", skill_slug: "swept" },
  ];
  const fakePool = { query: async () => ({ rows }) } as unknown as Parameters<typeof relocateMovedRepos>[0];
  assert.equal(await relocateMovedRepos(fakePool, root), 1);
  assert.ok(await repoProvisioned(root, "team-h", "swept"));
});

test("pickServedRepo prefers the canonical repo, falls back to a provisioned old address", async () => {
  await synth("old-ns", "pick", "1.0.0");
  const canonical = { namespaceSlug: "new-ns", skillSlug: "pick" };
  const old = { namespaceSlug: "old-ns", skillSlug: "pick" };
  assert.deepEqual(await pickServedRepo(root, [canonical, old]), old);
  await synth("new-ns", "pick", "1.0.0");
  assert.deepEqual(await pickServedRepo(root, [canonical, old]), canonical);
  assert.equal(await pickServedRepo(root, [{ namespaceSlug: "none", skillSlug: "none" }]), null);
  // An unsafe candidate is skipped, never thrown.
  assert.deepEqual(await pickServedRepo(root, [{ namespaceSlug: "..", skillSlug: "x" }, canonical]), canonical);
});

test("rewriteRepoPathInfo swaps only the repo prefix", () => {
  const from = { namespaceSlug: "team-a", skillSlug: "foo" };
  const to = { namespaceSlug: "team-b", skillSlug: "foo" };
  assert.equal(rewriteRepoPathInfo("/team-a/foo.git/info/refs", from, to), "/team-b/foo.git/info/refs");
  assert.equal(rewriteRepoPathInfo("/team-a/foo.git/git-upload-pack", from, to), "/team-b/foo.git/git-upload-pack");
  assert.equal(rewriteRepoPathInfo("/team-a/foo.git/HEAD", from, from), "/team-a/foo.git/HEAD");
  assert.equal(rewriteRepoPathInfo("/other/x.git/info/refs", from, to), "/other/x.git/info/refs");
});
