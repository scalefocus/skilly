// Unit tests for the Installed page's sort toggle + highlight helpers (SKILLY_SPEC.md §23).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterInstalls,
  installRef,
  installedHighlightHref,
  INSTALLED_SORT_KEY,
  parseInstalledSort,
  sortInstalls,
} from "./installedFilter";

const rows = [
  { title: "pdf Tools", namespaceSlug: "global", skillSlug: "pdf-tools", installedAt: "2026-10-12T10:00:00Z" },
  { title: "Lint Fixer", namespaceSlug: "global", skillSlug: "lint-fixer", installedAt: "2026-10-05T10:00:00Z" },
  { title: "Web Scraper", namespaceSlug: "global", skillSlug: "web-scraper", installedAt: "2026-10-15T09:00:00Z" },
  // Same title as the first row, installed earlier — the A–Z tie-break puts the newer one first.
  { title: "PDF Tools", namespaceSlug: "team-a", skillSlug: "pdf-tools", installedAt: "2026-10-01T10:00:00Z" },
];

test("parseInstalledSort: only 'recent' is recent; anything else (incl. nothing stored) is the A–Z default", () => {
  assert.equal(parseInstalledSort("recent"), "recent");
  assert.equal(parseInstalledSort("alpha"), "alpha");
  assert.equal(parseInstalledSort(null), "alpha");
  assert.equal(parseInstalledSort(undefined), "alpha");
  assert.equal(parseInstalledSort("RECENT"), "alpha");
  assert.equal(INSTALLED_SORT_KEY, "skilly.installedSort");
});

test("alpha: title A–Z case-insensitively, ties broken by most-recent install", () => {
  assert.deepEqual(
    sortInstalls(rows, "alpha").map(installRef),
    ["global/lint-fixer", "global/pdf-tools", "team-a/pdf-tools", "global/web-scraper"],
  );
});

test("recent: newest install first, ties broken by title A–Z", () => {
  assert.deepEqual(
    sortInstalls(rows, "recent").map(installRef),
    ["global/web-scraper", "global/pdf-tools", "global/lint-fixer", "team-a/pdf-tools"],
  );
  const tie = [
    { title: "Zeta", installedAt: "2026-10-01T00:00:00Z" },
    { title: "alpha", installedAt: "2026-10-01T00:00:00Z" },
  ];
  assert.deepEqual(sortInstalls(tie, "recent").map((r) => r.title), ["alpha", "Zeta"]);
});

test("sorting returns a new array and leaves the API order untouched", () => {
  const before = rows.map(installRef);
  const out = sortInstalls(rows, "recent");
  assert.notEqual(out, rows);
  assert.deepEqual(rows.map(installRef), before);
});

test("composes with the header search — the sort applies to the surviving rows", () => {
  assert.deepEqual(sortInstalls(filterInstalls(rows, "pdf"), "recent").map(installRef), ["global/pdf-tools", "team-a/pdf-tools"]);
});

test("installRef / installedHighlightHref name the skill the same way the ?highlight= param does", () => {
  assert.equal(installRef(rows[2]!), "global/web-scraper");
  assert.equal(installedHighlightHref("global", "web-scraper"), "/installed?highlight=global/web-scraper");
  assert.equal(new URLSearchParams(installedHighlightHref("team-a", "pdf-tools").split("?")[1]).get("highlight"), "team-a/pdf-tools");
});
