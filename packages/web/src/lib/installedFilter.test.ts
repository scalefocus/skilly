import { test } from "node:test";
import assert from "node:assert/strict";
import { filterInstalls, installMatches, type InstallSearchFields } from "./installedFilter";

// A small fixture set mirroring the shape of installed rows (§23). Only the searched fields matter.
const rows: InstallSearchFields[] = [
  { title: "PDF Tools", namespaceSlug: "global", skillSlug: "pdf-tools" },
  { title: "Frontend Design", namespaceSlug: "team-a", skillSlug: "frontend-design" },
  { title: "Invoice Parser", namespaceSlug: "finance", skillSlug: "invoice-parser" },
];

test("empty / whitespace query returns the list unchanged (same reference)", () => {
  assert.equal(filterInstalls(rows, ""), rows);
  assert.equal(filterInstalls(rows, "   "), rows);
});

test("matches on the title, case-insensitively", () => {
  const out = filterInstalls(rows, "pdf");
  assert.deepEqual(out.map((r) => r.skillSlug), ["pdf-tools"]);
  assert.deepEqual(filterInstalls(rows, "DESIGN").map((r) => r.skillSlug), ["frontend-design"]);
});

test("matches on the namespace slug", () => {
  assert.deepEqual(filterInstalls(rows, "team-a").map((r) => r.skillSlug), ["frontend-design"]);
  assert.deepEqual(filterInstalls(rows, "finance").map((r) => r.skillSlug), ["invoice-parser"]);
});

test("matches on the skill slug (substring, not just prefix)", () => {
  assert.deepEqual(filterInstalls(rows, "parser").map((r) => r.skillSlug), ["invoice-parser"]);
  assert.deepEqual(filterInstalls(rows, "-tools").map((r) => r.skillSlug), ["pdf-tools"]);
});

test("does NOT match unrelated terms", () => {
  assert.deepEqual(filterInstalls(rows, "nomatch"), []);
});

test("query is trimmed before matching", () => {
  assert.deepEqual(filterInstalls(rows, "  invoice  ").map((r) => r.skillSlug), ["invoice-parser"]);
});

test("preserves input order among matches", () => {
  // "e" appears in every row's title/slug; result order must equal input order.
  const out = filterInstalls(rows, "e");
  assert.deepEqual(out.map((r) => r.skillSlug), ["frontend-design", "invoice-parser"]);
});

test("installMatches: empty needle matches everything; only searches the three fields", () => {
  const row = rows[0]!;
  assert.equal(installMatches(row, ""), true);
  assert.equal(installMatches(row, "pdf"), true);
  assert.equal(installMatches(row, "global"), true);
  // A term that would only appear in non-searched fields (e.g. a version like "v1.2.0") never matches.
  assert.equal(installMatches(row, "v1.2.0"), false);
});
