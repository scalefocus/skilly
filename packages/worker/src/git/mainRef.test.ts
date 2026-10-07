// Real-git test for the deprecation-aware `main` reconciliation (SKILLY_SPEC.md §45.4, §6).
// Synthesizes two versions, then drives ensureMain through deprecate → edit → un-deprecate and
// asserts: tags never move, `main` is a commit whose PARENT is the latest-stable tag commit, the
// rewritten SKILL.md carries the hint while a pinned read of the tag is byte-identical, the hint
// SHA is deterministic (recomputed from scratch it is the same commit), and un-deprecating puts
// `main` back on the tag commit.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { synthesizeVersion, listTags } from "./synth.js";
import { ensureMain, hintCommitFor, readRefFs, applyDeprecationHint, NOT_DEPRECATED, type DeprecationHintState } from "./mainRef.js";

const exec = promisify(execFile);
const enc = (s: string) => new TextEncoder().encode(s);
const git = async (bare: string, ...args: string[]) => (await exec("git", ["--git-dir", bare, ...args])).stdout.trim();

let workDir: string;
let bare: string;
const MD = "---\nname: pdf\ndescription: Work with PDFs\n---\n\n# PDF\n\nBody.\n";
const DEP: DeprecationHintState = { deprecated: true, successor: "team-a/pdf-next", note: "Use the new one.", successorUrl: "https://skilly.test/skills/team-a/pdf-next" };

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "skilly-mainref-"));
  bare = join(workDir, "team-a", "pdf.git");
  await synthesizeVersion({ bareRepoPath: bare, semver: "1.0.0", files: [{ path: "SKILL.md", bytes: enc(MD) }], isLatestStable: false });
  await synthesizeVersion({ bareRepoPath: bare, semver: "1.1.0", files: [{ path: "SKILL.md", bytes: enc(MD) }, { path: "scripts/run.sh", bytes: enc("#!/bin/sh\n"), mode: "100755" }], isLatestStable: true });
});
after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

test("ensureMain: deprecated → hint commit on top of the latest tag; tags untouched; pinned bytes identical", async () => {
  const tagsBefore = await Promise.all((await listTags(bare)).map((t) => git(bare, "rev-parse", `refs/tags/${t}^{commit}`)));
  const tag110 = await git(bare, "rev-parse", "refs/tags/v1.1.0^{commit}");
  assert.equal(await readRefFs(bare, "refs/heads/main"), tag110, "starts on the tag commit");

  assert.equal(await ensureMain(bare, "v1.1.0", DEP), "updated");
  const main = (await readRefFs(bare, "refs/heads/main"))!;
  assert.notEqual(main, tag110);
  assert.equal(await git(bare, "rev-parse", `${main}^`), tag110, "the hint commit's parent is the tag commit");
  assert.equal(await git(bare, "log", "-1", "--format=%s", main), "skilly: deprecation notice");

  const onMain = await git(bare, "show", `${main}:SKILL.md`);
  assert.match(onMain, /^---\ndeprecated: true\nsuperseded_by: "team-a\/pdf-next"\nname: pdf\n/);
  assert.match(onMain, /description: DEPRECATED — use team-a\/pdf-next instead\. Work with PDFs/);
  assert.match(onMain, /> \*\*Deprecated\.\*\* Use `team-a\/pdf-next` instead — https:\/\/skilly\.test\/skills\/team-a\/pdf-next\n>\n> Use the new one\./);
  assert.equal(await git(bare, "show", "refs/tags/v1.1.0:SKILL.md"), MD.trimEnd(), "the tag's SKILL.md is the artifact, byte for byte");
  assert.equal(await git(bare, "show", `${main}:scripts/run.sh`), "#!/bin/sh", "other files ride along unchanged");
  assert.equal(await git(bare, "ls-tree", "-l", main, "scripts/run.sh").then((s) => s.split(" ")[0]), "100755", "modes survive");

  const tagsAfter = await Promise.all((await listTags(bare)).map((t) => git(bare, "rev-parse", `refs/tags/${t}^{commit}`)));
  assert.deepEqual(tagsAfter, tagsBefore, "no tag moved");

  // Idempotent and deterministic: a second pass is a no-op; recomputing without the marker yields the same SHA.
  assert.equal(await ensureMain(bare, "v1.1.0", DEP), "unchanged");
  await unlink(join(bare, "skilly-deprecation-hint.json"));
  assert.equal(await hintCommitFor(bare, tag110, DEP), main, "same inputs ⇒ same commit SHA");
  assert.equal(await ensureMain(bare, "v1.1.0", DEP), "unchanged");
});

test("ensureMain: editing the successor replaces the hint; un-deprecating restores the tag commit", async () => {
  const tag110 = await git(bare, "rev-parse", "refs/tags/v1.1.0^{commit}");
  const before = await readRefFs(bare, "refs/heads/main");
  assert.equal(await ensureMain(bare, "v1.1.0", { ...DEP, successor: null, successorUrl: null }), "updated");
  const main = (await readRefFs(bare, "refs/heads/main"))!;
  assert.notEqual(main, before);
  const md = await git(bare, "show", `${main}:SKILL.md`);
  assert.doesNotMatch(md, /superseded_by/);
  assert.match(md, /description: DEPRECATED\. Work with PDFs/);
  assert.equal((md.match(/skilly:deprecation -->/g) ?? []).length, 2, "one banner, never stacked");

  assert.equal(await ensureMain(bare, "v1.1.0", NOT_DEPRECATED), "updated");
  assert.equal(await readRefFs(bare, "refs/heads/main"), tag110, "back on the tag commit");
  assert.equal(await ensureMain(bare, "v1.1.0", NOT_DEPRECATED), "unchanged");
});

test("ensureMain: no stable version → main deleted; a missing tag is reported, not invented", async () => {
  assert.equal(await ensureMain(bare, "v9.9.9", DEP), "missing-tag");
  assert.ok(await readRefFs(bare, "refs/heads/main"), "main left alone on a missing tag");
  assert.equal(await ensureMain(bare, null, NOT_DEPRECATED), "deleted");
  assert.equal(await readRefFs(bare, "refs/heads/main"), null);
  assert.equal(await ensureMain(bare, null, NOT_DEPRECATED), "unchanged");
  // Repair: back to the tag.
  assert.equal(await ensureMain(bare, "v1.1.0", NOT_DEPRECATED), "updated");
});

test("applyDeprecationHint rewrites only SKILL.md and only for a deprecated skill (marketplace copy)", () => {
  const files = [{ path: "SKILL.md", bytes: enc(MD) }, { path: "README.md", bytes: enc("hi") }];
  assert.deepEqual(applyDeprecationHint(files, NOT_DEPRECATED), files);
  const out = applyDeprecationHint(files, DEP);
  assert.match(Buffer.from(out[0]!.bytes).toString("utf8"), /^---\ndeprecated: true\n/);
  assert.equal(Buffer.from(out[1]!.bytes).toString("utf8"), "hi");
});
