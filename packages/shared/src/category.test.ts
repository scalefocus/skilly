// Category slug derivation + the reserved/collision checks (SKILLY_SPEC.md §10 *Category slugs*).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORY_SLUG_MAX,
  categoryCollisionError,
  categoryNameError,
  categorySlug,
  checkCategoryNames,
  isValidCategorySlug,
  normalizeCategoryNames,
} from "./category.js";

test("categorySlug: lowercase kebab, punctuation runs collapse, edges trimmed", () => {
  assert.equal(categorySlug("productivity"), "productivity");
  assert.equal(categorySlug("AI & ML"), "ai-ml");
  assert.equal(categorySlug("  Dev / Ops  "), "dev-ops");
  assert.equal(categorySlug("--data--"), "data");
  assert.equal(categorySlug("c++"), "c");
});

test("categorySlug: diacritics are stripped, not turned into hyphens", () => {
  assert.equal(categorySlug("café"), "cafe");
  assert.equal(categorySlug("Ünïcode Tëst"), "unicode-test");
});

test("categorySlug: empty when nothing survives; capped at the max", () => {
  assert.equal(categorySlug("&&&"), "");
  assert.equal(categorySlug(""), "");
  const long = "a".repeat(CATEGORY_SLUG_MAX + 20);
  assert.equal(categorySlug(long).length, CATEGORY_SLUG_MAX);
  assert.ok(isValidCategorySlug(categorySlug(long)));
  // A cut that would land on a hyphen is trimmed again so the slug stays well-formed.
  const hy = "a".repeat(CATEGORY_SLUG_MAX - 1) + "-bbbbbb";
  assert.ok(isValidCategorySlug(categorySlug(hy)));
});

test("categorySlug: linear on long hyphen and punctuation runs (no regex backtracking)", () => {
  const dashes = "-".repeat(200_000);
  const started = Date.now();
  assert.equal(categorySlug(`${dashes}x`), "x");
  assert.equal(categorySlug(`x${dashes}`), "x");
  assert.equal(categorySlug(`${dashes}a${dashes}b${dashes}`), "a-b");
  assert.equal(categorySlug(`${"!".repeat(200_000)}data`), "data");
  assert.equal(categorySlug(dashes), "");
  assert.ok(Date.now() - started < 1_000, "200k-character names slug in well under a second");
});

test("categoryNameError: reserved `general` in any spelling, with an explanation", () => {
  for (const n of ["general", "General", " GENERAL ", "géneral", "general!"]) {
    const err = categoryNameError(n);
    assert.ok(err && /reserved/.test(err) && /without a category/.test(err), `${n}: ${err}`);
  }
  assert.equal(categoryNameError("generally"), null);
  assert.ok(/letter or digit/.test(categoryNameError("&&&") ?? ""));
  assert.equal(categoryNameError("productivity"), null);
});

test("categoryCollisionError: a different name with the same slug names the winner", () => {
  const known = [{ name: "ai & ml", slug: "ai-ml" }, { name: "documents", slug: "documents" }];
  const err = categoryCollisionError("ai ml", known);
  assert.ok(err && err.includes("`ai-ml`") && err.includes("“ai & ml”"), err ?? "");
  // The same name (any case/whitespace) is the same category, not a collision.
  assert.equal(categoryCollisionError("AI & ML", known), null);
  assert.equal(categoryCollisionError("documents", known), null);
  assert.equal(categoryCollisionError("brand-new", known), null);
});

test("checkCategoryNames: first problem wins; clean lists pass", () => {
  const known = [{ name: "ai & ml", slug: "ai-ml" }];
  assert.equal(checkCategoryNames(["documents", "ai & ml"], known), null);
  assert.match(checkCategoryNames(["documents", "general"], known) ?? "", /reserved/);
  assert.match(checkCategoryNames(["ai ml"], known) ?? "", /would share the plugin name/);
});

test("normalizeCategoryNames: trim, lowercase, de-dupe, cap", () => {
  assert.deepEqual(normalizeCategoryNames([" Docs ", "docs", "", "Data"]), ["docs", "data"]);
  assert.equal(normalizeCategoryNames(Array.from({ length: 20 }, (_, i) => `c${i}`)).length, 12);
});
