import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, DIFF_MAX_LINES_PER_SIDE, type LineDiff } from "./linediff.js";

function unwrap(oldText: string, newText: string): LineDiff {
  const r = diffLines(oldText, newText);
  assert.equal(r.ok, true, "expected a diff, got too-large");
  return (r as { ok: true; diff: LineDiff }).diff;
}

test("identical text produces no hunks and zero counts", () => {
  const d = unwrap("a\nb\nc\n", "a\nb\nc\n");
  assert.deepEqual(d.hunks, []);
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
});

test("a single changed line is one del + one add", () => {
  const d = unwrap("a\nb\nc\n", "a\nB\nc\n");
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  const types = d.hunks.flatMap((h) => h.lines.map((l) => l.type));
  assert.ok(types.includes("del"));
  assert.ok(types.includes("add"));
  // the 'b'→'B' change carries correct 1-based line numbers
  const del = d.hunks.flatMap((h) => h.lines).find((l) => l.type === "del")!;
  const add = d.hunks.flatMap((h) => h.lines).find((l) => l.type === "add")!;
  assert.equal(del.oldLine, 2);
  assert.equal(add.newLine, 2);
});

test("pure additions and pure deletions are counted correctly", () => {
  assert.deepEqual([unwrap("a\n", "a\nb\nc\n").added, unwrap("a\n", "a\nb\nc\n").removed], [2, 0]);
  assert.deepEqual([unwrap("a\nb\nc\n", "a\n").added, unwrap("a\nb\nc\n", "a\n").removed], [0, 2]);
});

test("context lines around a change are included but not counted as changes", () => {
  const oldText = "l1\nl2\nl3\nl4\nl5\nl6\nl7\n";
  const newText = "l1\nl2\nl3\nX4\nl5\nl6\nl7\n";
  const d = unwrap(oldText, newText);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  // exactly one hunk with 3 lines of context on each side of the single change
  assert.equal(d.hunks.length, 1);
  const ctx = d.hunks[0]!.lines.filter((l) => l.type === "context");
  assert.equal(ctx.length, 6);
});

test("distant changes split into separate hunks; near changes merge", () => {
  const oldText = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  // change line 1 and line 18 — far apart → two hunks
  const lines = oldText.split("\n");
  lines[1] = "CHANGED1";
  lines[18] = "CHANGED18";
  const far = unwrap(oldText, lines.join("\n"));
  assert.equal(far.hunks.length, 2);
});

test("trailing-newline difference is not treated as an extra line", () => {
  const d = unwrap("a\nb", "a\nb\n");
  assert.deepEqual(d.hunks, []);
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
});

test("a file over the line cap is refused as too-large", () => {
  const big = Array.from({ length: DIFF_MAX_LINES_PER_SIDE + 1 }, (_, i) => `l${i}`).join("\n");
  const r = diffLines(big, big + "\nextra");
  assert.equal(r.ok, false);
  assert.equal((r as { ok: false; reason: string }).reason, "too-large");
});

test("empty old text → all lines added", () => {
  const d = unwrap("", "a\nb\n");
  assert.equal(d.added, 2);
  assert.equal(d.removed, 0);
});
