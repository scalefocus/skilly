// Unit tests for the pure parts of presence.ts (SKILLY_SPEC.md §4) — no DB. The throttled
// touchLastSeen/listOnlineUsers DB behavior is covered in presence.dbtest.ts.
// Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizePageLabel, MAX_PAGE_LABEL_LEN } from "./presence";

test("sanitizePageLabel: trims whitespace", () => {
  assert.equal(sanitizePageLabel("  Catalog  "), "Catalog");
});

test("sanitizePageLabel: non-string input resolves to null", () => {
  assert.equal(sanitizePageLabel(undefined), null);
  assert.equal(sanitizePageLabel(null), null);
  assert.equal(sanitizePageLabel(42), null);
  assert.equal(sanitizePageLabel({ label: "Catalog" }), null);
});

test("sanitizePageLabel: empty or whitespace-only resolves to null", () => {
  assert.equal(sanitizePageLabel(""), null);
  assert.equal(sanitizePageLabel("   "), null);
});

test("sanitizePageLabel: caps to MAX_PAGE_LABEL_LEN", () => {
  const huge = "x".repeat(500);
  const out = sanitizePageLabel(huge);
  assert.equal(out?.length, MAX_PAGE_LABEL_LEN);
  assert.equal(out, "x".repeat(MAX_PAGE_LABEL_LEN));
});

test("sanitizePageLabel: passes a normal resolved label through unchanged", () => {
  const label = "Skill: SEO Checklist";
  assert.equal(sanitizePageLabel(label), label);
});
