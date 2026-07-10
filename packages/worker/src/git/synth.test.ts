// Integration test for repo synthesis — uses the real `git` binary. Synthesizes two
// versions into a bare repo, then clones it back and verifies tags, contents, and that
// `main` tracks the latest stable. Also asserts version-tag immutability.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { synthesizeVersion, listTags, pointMainAtTag } from "./synth.js";
import { repoProvisioned, repoPath } from "./repoStore.js";

const exec = promisify(execFile);
const enc = (s: string) => new TextEncoder().encode(s);

let workDir: string;
let bare: string;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "skilly-synth-"));
  bare = join(workDir, "team-a", "pdf.git");
});
after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

test("synthesizes versions, tags are immutable, main tracks latest stable", async () => {
  // v1.0.0 (latest stable) — SKILL.md is synthesized at the repo ROOT (the layout
  // `npx skills add` reads for a single-skill repo).
  await synthesizeVersion({
    bareRepoPath: bare,
    semver: "1.0.0",
    isLatestStable: true,
    files: [
      { path: "SKILL.md", bytes: enc("---\nname: pdf\ndescription: v1\n---\n# PDF v1\n") },
      { path: "scripts/run.sh", bytes: enc("echo hi\n"), mode: "100755" },
    ],
  });

  // v1.1.0 (new latest stable)
  await synthesizeVersion({
    bareRepoPath: bare,
    semver: "1.1.0",
    isLatestStable: true,
    files: [{ path: "SKILL.md", bytes: enc("---\nname: pdf\ndescription: v1.1\n---\n# PDF v1.1\n") }],
  });

  // Immutability: re-publishing an existing version tag must fail.
  await assert.rejects(
    synthesizeVersion({
      bareRepoPath: bare,
      semver: "1.0.0",
      isLatestStable: false,
      files: [{ path: "SKILL.md", bytes: enc("tampered") }],
    }),
    /already exists/,
  );

  // Clone the bare repo and verify what a consumer would get. We read STORED OBJECTS via
  // `git show <ref>:<path>` (raw blob bytes — no working-tree eol/autocrlf filtering), so
  // the assertions reflect exactly what skilly stored, independent of the runner's git.
  const clone = join(workDir, "clone");
  await exec("git", ["clone", bare, clone]);
  const show = async (ref: string, path: string) =>
    (await exec("git", ["-C", clone, "show", `${ref}:${path}`])).stdout;

  const tags = (await exec("git", ["-C", clone, "tag", "--list"])).stdout.trim().split("\n").map((t) => t.trim()).sort();
  assert.deepEqual(tags, ["v1.0.0", "v1.1.0"]);

  // Default branch (main) = latest stable = v1.1.0. SKILL.md is at the repo root.
  assert.match(await show("refs/heads/main", "SKILL.md"), /v1\.1/);

  // The exact v1.0.0 tag yields the v1 snapshot + the bundled script, byte-for-byte.
  assert.match(await show("v1.0.0", "SKILL.md"), /# PDF v1\b/);
  assert.equal(await show("v1.0.0", "scripts/run.sh"), "echo hi\n");
});

test("repoProvisioned: an init'd-but-ref-less repo is NOT provisioned; synthesis makes it so", async () => {
  // Reproduces the bug: synthesis that created the bare repo then crashed before writing any
  // tag leaves HEAD but zero refs. The git server must NOT serve it (empty clone → misleading
  // "No skills found"), and the self-heal sweep must re-synthesize it. SKILLY_SPEC.md §6.
  const root = await mkdtemp(join(tmpdir(), "skilly-prov-"));
  try {
    const dir = repoPath(root, "team-a", "empty");
    await mkdir(dir, { recursive: true });
    await exec("git", ["init", "--bare", "--initial-branch=main", dir]);

    // HEAD exists but there are no refs → not provisioned.
    assert.equal(await repoProvisioned(root, "team-a", "empty"), false);

    // After a successful synthesis the version tag exists → provisioned.
    await synthesizeVersion({
      bareRepoPath: dir,
      semver: "1.0.0",
      isLatestStable: true,
      files: [{ path: "SKILL.md", bytes: enc("---\nname: empty\ndescription: x\n---\n# x\n") }],
    });
    assert.equal(await repoProvisioned(root, "team-a", "empty"), true);

    // A non-existent repo is also not provisioned.
    assert.equal(await repoProvisioned(root, "team-a", "nope"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("self-heal helpers: listTags + pointMainAtTag repair a tags-but-no-main repo", async () => {
  // Reproduces the "tags present but main unborn/stale" partial state: a fragment-less
  // `npx skills add` clones `main`, so a missing/stale main yields an empty clone even though
  // the version tags exist. pointMainAtTag must restore main to the latest-stable tag. §6.
  const root = await mkdtemp(join(tmpdir(), "skilly-main-"));
  try {
    const dir = repoPath(root, "team-a", "fix");
    await synthesizeVersion({
      bareRepoPath: dir,
      semver: "1.0.0",
      isLatestStable: true,
      files: [{ path: "SKILL.md", bytes: enc("---\nname: fix\ndescription: x\n---\n# x\n") }],
    });
    assert.deepEqual((await listTags(dir)).sort(), ["v1.0.0"]);

    // Simulate the broken state: delete main, leaving only the tag.
    await exec("git", ["--git-dir", dir, "update-ref", "-d", "refs/heads/main"]);
    await assert.rejects(exec("git", ["--git-dir", dir, "rev-parse", "--verify", "refs/heads/main"]));

    // First repair recreates main at the tag; a second call is a no-op (already correct).
    assert.equal(await pointMainAtTag(dir, "v1.0.0"), true);
    assert.equal(await pointMainAtTag(dir, "v1.0.0"), false);

    const main = (await exec("git", ["--git-dir", dir, "rev-parse", "refs/heads/main"])).stdout.trim();
    const tag = (await exec("git", ["--git-dir", dir, "rev-parse", "refs/tags/v1.0.0^{commit}"])).stdout.trim();
    assert.equal(main, tag);

    // A tag that doesn't exist is a no-op (caller re-synthesizes the version instead).
    assert.equal(await pointMainAtTag(dir, "v9.9.9"), false);
    // listTags on a non-existent repo is empty (not an error).
    assert.deepEqual(await listTags(repoPath(root, "team-a", "nope")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
