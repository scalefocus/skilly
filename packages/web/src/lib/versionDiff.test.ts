// Unit tests for the file-change engine shared by the reviewer view (§8) and the published
// per-version view on the skill detail page (§10): added/modified/removed/unchanged by per-file
// content hash, rename = remove + add, binary/text handling, and the inline line diff. Pure —
// operates on in-memory entry lists, so no DB and no object store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEntries, diffEntriesPath } from "./versionDiff";
import type { BundleEntry } from "@skilly/shared";

const f = (path: string, text: string): BundleEntry => ({ path, bytes: new TextEncoder().encode(text) });
const bin = (path: string): BundleEntry => ({ path, bytes: new Uint8Array([0x00, 0x01, 0x02, 0x00]) });
const statusOf = (s: ReturnType<typeof classifyEntries>, path: string) => s.files.find((x) => x.path === path)?.status;

test("classifies added / modified / removed / unchanged by content", () => {
  const base = [f("SKILL.md", "old\n"), f("keep.md", "same\n"), f("gone.md", "bye\n")];
  const next = [f("SKILL.md", "new\n"), f("keep.md", "same\n"), f("added.md", "hi\n")];
  const s = classifyEntries("1.0.0", base, next);

  assert.equal(s.baselineSemver, "1.0.0");
  assert.deepEqual([s.added, s.modified, s.removed, s.unchanged], [1, 1, 1, 1]);
  assert.equal(statusOf(s, "added.md"), "added");
  assert.equal(statusOf(s, "SKILL.md"), "modified");
  assert.equal(statusOf(s, "gone.md"), "removed");
  assert.equal(statusOf(s, "keep.md"), "unchanged");
});

test("a metadata-only re-version (identical bytes) reports no changes", () => {
  const same = [f("SKILL.md", "body\n"), f("ref/a.md", "a\n")];
  const s = classifyEntries("1.0.0", same, [...same]);
  assert.deepEqual([s.added, s.modified, s.removed], [0, 0, 0]);
  assert.equal(s.unchanged, 2);
});

test("a rename shows as a remove plus an add (no rename detection)", () => {
  const s = classifyEntries("1.0.0", [f("old-name.md", "identical\n")], [f("new-name.md", "identical\n")]);
  assert.equal(statusOf(s, "old-name.md"), "removed");
  assert.equal(statusOf(s, "new-name.md"), "added");
  assert.deepEqual([s.added, s.removed, s.modified], [1, 1, 0]);
});

test("no baseline (a skill's first version) marks every file added", () => {
  const s = classifyEntries(null, [], [f("SKILL.md", "x\n"), f("a.md", "y\n")]);
  assert.equal(s.baselineSemver, null);
  assert.equal(s.added, 2);
  assert.equal(s.files.every((x) => x.status === "added"), true);
});

test("binary files are flagged non-text and diff to a binary marker", () => {
  const s = classifyEntries("1.0.0", [bin("logo.png")], [bin("logo.png"), f("SKILL.md", "t\n")]);
  assert.equal(s.files.find((x) => x.path === "logo.png")?.isText, false);
  assert.equal(s.files.find((x) => x.path === "SKILL.md")?.isText, true);

  const d = diffEntriesPath([bin("logo.png")], [f("logo.png", "now text\n")], "logo.png");
  assert.deepEqual(d, { status: "modified", isText: false, binary: true });
});

test("a modified text file yields a unified line diff; an unknown path yields null", () => {
  const d = diffEntriesPath([f("SKILL.md", "line1\nline2\n")], [f("SKILL.md", "line1\nline2 changed\n")], "SKILL.md");
  assert.ok(d && "diff" in d, "expected a line diff");
  assert.equal(d.status, "modified");
  assert.ok(d.diff.hunks.length > 0);
  assert.equal(d.diff.added, 1);
  assert.equal(d.diff.removed, 1);

  assert.equal(diffEntriesPath([], [f("a.md", "x\n")], "nope.md"), null);
});

test("file sizes report the side that exists (proposed, or baseline for a removal)", () => {
  const s = classifyEntries("1.0.0", [f("gone.md", "0123456789")], [f("new.md", "abc")]);
  assert.equal(s.files.find((x) => x.path === "gone.md")?.size, 10);
  assert.equal(s.files.find((x) => x.path === "new.md")?.size, 3);
});
