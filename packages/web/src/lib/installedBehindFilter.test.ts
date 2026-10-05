// Unit tests for the Installed page's "Behind latest" chip and its composition with the header
// search (SKILLY_SPEC.md §23 "Installed-version freshness").
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Freshness } from "@skilly/shared/freshness";
import { filterBehind, filterInstalls, type InstallSearchFields } from "./installedFilter";

type Row = InstallSearchFields & { freshness: Freshness };
const rows: Row[] = [
  { title: "Acme Linter", namespaceSlug: "team-a", skillSlug: "acme-linter", freshness: "behind" },
  { title: "Frontend Design", namespaceSlug: "team-a", skillSlug: "frontend-design", freshness: "current" },
  { title: "Invoice Parser", namespaceSlug: "finance", skillSlug: "invoice-parser", freshness: "withdrawn" },
  { title: "PDF Tools", namespaceSlug: "global", skillSlug: "pdf-tools", freshness: "unknown" },
];

test("chip off returns the list unchanged (same reference)", () => {
  assert.equal(filterBehind(rows, false), rows);
});

test("chip on keeps behind + withdrawn, drops current + unknown, preserves order", () => {
  assert.deepEqual(filterBehind(rows, true).map((r) => r.skillSlug), ["acme-linter", "invoice-parser"]);
});

test("composes with the header search: ?q= narrows within the behind set, in either order", () => {
  const a = filterInstalls(filterBehind(rows, true), "team-a").map((r) => r.skillSlug);
  const b = filterBehind(filterInstalls(rows, "team-a"), true).map((r) => r.skillSlug);
  assert.deepEqual(a, ["acme-linter"]);
  assert.deepEqual(b, ["acme-linter"]);
  // A query that only matches up-to-date rows + the chip → nothing (the "no match" state).
  assert.deepEqual(filterInstalls(filterBehind(rows, true), "pdf"), []);
});
