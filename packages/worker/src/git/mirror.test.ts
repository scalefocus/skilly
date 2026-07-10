// Hermetic test for pointer mirroring's clone+pack. Builds an "external" repo via synth,
// then mirrors a pinned tag from it and checks the packed bundle (real git).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneAndPack } from "./mirror.js";
import { synthesizeVersion } from "./synth.js";

// This hermetic test mirrors from a local bare repo, so allow the worker's file:// clone.
// Production leaves this unset (https:// only — SSRF guard, §6).
process.env.SKILLY_MIRROR_ALLOW_INSECURE = "1";

const enc = (s: string) => new TextEncoder().encode(s);
let work: string;
let externalRepo: string;
let multiRepo: string;

before(async () => {
  work = await mkdtemp(join(tmpdir(), "skilly-mirrortest-"));
  externalRepo = join(work, "external.git");
  await synthesizeVersion({
    bareRepoPath: externalRepo,
    semver: "1.0.0",
    isLatestStable: true,
    files: [
      { path: "SKILL.md", bytes: enc("---\nname: ext\ndescription: external skill\n---\n# external\n") },
      { path: "scripts/go.sh", bytes: enc("echo go\n") },
    ],
  });

  // A multi-skill mono-repo (like anthropics/skills): each skill in its own folder, plus
  // repo-level files that must NOT leak into a single-skill mirror.
  multiRepo = join(work, "multi.git");
  await synthesizeVersion({
    bareRepoPath: multiRepo,
    semver: "1.0.0",
    isLatestStable: true,
    files: [
      // A root SKILL.md (synth requires one); the subdir mirror must DROP it.
      { path: "SKILL.md", bytes: enc("---\nname: monorepo-root\ndescription: repo root\n---\n# root\n") },
      { path: "README.md", bytes: enc("# mono-repo of skills\n") },
      { path: "frontend-design/SKILL.md", bytes: enc("---\nname: frontend-design\ndescription: fe skill\n---\n# fe\n") },
      { path: "frontend-design/assets/logo.txt", bytes: enc("logo\n") },
      { path: "pdf-tools/SKILL.md", bytes: enc("---\nname: pdf-tools\ndescription: pdf skill\n---\n# pdf\n") },
      // Standard Claude-skills nesting: SKILL.md under .claude/skills/<name>/ rather than a
      // top-level folder. Mirroring must locate it when the proposer pins just "<name>".
      { path: ".claude/skills/nested-skill/SKILL.md", bytes: enc("---\nname: nested-skill\ndescription: nested\n---\n# nested\n") },
      { path: ".claude/skills/nested-skill/helper.txt", bytes: enc("help\n") },
    ],
  });
});
after(async () => {
  await rm(work, { recursive: true, force: true });
});

test("clones a pinned tag and packs the bundle (excluding .git)", async () => {
  const { files, targz } = await cloneAndPack(externalRepo, "v1.0.0");
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["SKILL.md", "scripts/go.sh"]);
  assert.ok(!paths.some((p) => p.startsWith(".git")), "no .git contents");
  assert.ok(targz.byteLength > 0, "produced a tar.gz");
  const md = new TextDecoder().decode(files.find((f) => f.path === "SKILL.md")!.bytes);
  assert.match(md, /external skill/);
});

test("rejects a non-existent ref", async () => {
  await assert.rejects(cloneAndPack(externalRepo, "v9.9.9"));
});

test("mirrors only the requested subdir, rebased to root", async () => {
  const { files } = await cloneAndPack(multiRepo, "v1.0.0", "frontend-design");
  const paths = files.map((f) => f.path).sort();
  // Only the frontend-design subtree, rebased so SKILL.md is at the root — no README, no pdf-tools.
  assert.deepEqual(paths, ["SKILL.md", "assets/logo.txt"]);
  const md = new TextDecoder().decode(files.find((f) => f.path === "SKILL.md")!.bytes);
  assert.match(md, /name: frontend-design/);
});

test("fails loudly when the subdir has no SKILL.md", async () => {
  await assert.rejects(cloneAndPack(multiRepo, "v1.0.0", "does-not-exist"), /no SKILL.md found for 'does-not-exist'/);
});

test("finds a skill nested under .claude/skills/<name> when the subdir is just the name", async () => {
  const { files } = await cloneAndPack(multiRepo, "v1.0.0", "nested-skill");
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["SKILL.md", "helper.txt"]); // rebased to root from .claude/skills/nested-skill
  const md = new TextDecoder().decode(files.find((f) => f.path === "SKILL.md")!.bytes);
  assert.match(md, /name: nested-skill/);
});

test("tolerates the v-prefix convention mismatch (pins '1.0.0' when the tag is 'v1.0.0')", async () => {
  const { files } = await cloneAndPack(externalRepo, "1.0.0");
  assert.ok(files.some((f) => f.path === "SKILL.md"), "resolved the v-prefixed tag");
});

test("rejects a traversal subdir", async () => {
  await assert.rejects(cloneAndPack(multiRepo, "v1.0.0", "../etc"), /unsafe pointer subdir/);
});
