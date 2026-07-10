// Unit tests for the presence page-beacon route→label resolver (SKILLY_SPEC.md §4). Pure — no
// React, no DB. Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStaticPageLabel } from "./pageLabel";

test("resolveStaticPageLabel: exact match for the home route", () => {
  assert.equal(resolveStaticPageLabel("/"), "Overview");
});

test("resolveStaticPageLabel: prefix match for fixed pages", () => {
  assert.equal(resolveStaticPageLabel("/catalog"), "Catalog");
  assert.equal(resolveStaticPageLabel("/admin"), "Administration");
  assert.equal(resolveStaticPageLabel("/system-log"), "System log");
  assert.equal(resolveStaticPageLabel("/whats-new"), "What's new");
});

test("resolveStaticPageLabel: dynamic-title routes fall back to their generic default", () => {
  // The specific title (e.g. "Skill: <name>") is applied client-side once the page's own data
  // has loaded (usePageLabelOverride) — this resolver only ever sees the static default.
  assert.equal(resolveStaticPageLabel("/skills/marketing/seo-checklist"), "Skill");
  assert.equal(resolveStaticPageLabel("/requests/abc-123"), "Requested skills");
  assert.equal(resolveStaticPageLabel("/proposals/xyz-789"), "Review queue");
});

test("resolveStaticPageLabel: longest-prefix match doesn't get shadowed", () => {
  // /system-log must resolve to its own label, not fall through to an unrelated shorter prefix.
  assert.equal(resolveStaticPageLabel("/system-log"), "System log");
  assert.notEqual(resolveStaticPageLabel("/system-log"), resolveStaticPageLabel("/"));
});

test("resolveStaticPageLabel: unrecognized routes resolve to null (nothing to beacon)", () => {
  assert.equal(resolveStaticPageLabel("/tokens"), null);
  assert.equal(resolveStaticPageLabel("/some-unmapped-route"), null);
});
