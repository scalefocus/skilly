import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEATURED_MAX_DEFAULT,
  FEATURED_MAX_MIN,
  FEATURED_MAX_MAX,
  isValidFeaturedMax,
  coerceMaxFeatured,
  assertMaxFeatured,
} from "./featured.js";

test("isValidFeaturedMax accepts whole numbers within [MIN, MAX] only", () => {
  assert.equal(isValidFeaturedMax(FEATURED_MAX_MIN), true);
  assert.equal(isValidFeaturedMax(FEATURED_MAX_MAX), true);
  assert.equal(isValidFeaturedMax(10), true);
  // out of range
  assert.equal(isValidFeaturedMax(0), false);
  assert.equal(isValidFeaturedMax(FEATURED_MAX_MAX + 1), false);
  assert.equal(isValidFeaturedMax(-3), false);
  // not a whole number
  assert.equal(isValidFeaturedMax(10.5), false);
  assert.equal(isValidFeaturedMax(NaN), false);
  // wrong type / missing
  assert.equal(isValidFeaturedMax("10"), false);
  assert.equal(isValidFeaturedMax(null), false);
  assert.equal(isValidFeaturedMax(undefined), false);
});

test("coerceMaxFeatured falls back to the default on anything malformed", () => {
  assert.equal(coerceMaxFeatured(7), 7);
  assert.equal(coerceMaxFeatured(FEATURED_MAX_MIN), FEATURED_MAX_MIN);
  assert.equal(coerceMaxFeatured(FEATURED_MAX_MAX), FEATURED_MAX_MAX);
  // malformed / out of range → default
  assert.equal(coerceMaxFeatured(0), FEATURED_MAX_DEFAULT);
  assert.equal(coerceMaxFeatured(999), FEATURED_MAX_DEFAULT);
  assert.equal(coerceMaxFeatured("10"), FEATURED_MAX_DEFAULT);
  assert.equal(coerceMaxFeatured(undefined), FEATURED_MAX_DEFAULT);
  assert.equal(coerceMaxFeatured(null), FEATURED_MAX_DEFAULT);
  assert.equal(coerceMaxFeatured(3.5), FEATURED_MAX_DEFAULT);
});

test("assertMaxFeatured throws on invalid, passes on valid", () => {
  assert.doesNotThrow(() => assertMaxFeatured(1));
  assert.doesNotThrow(() => assertMaxFeatured(50));
  assert.doesNotThrow(() => assertMaxFeatured(10));
  assert.throws(() => assertMaxFeatured(0), /between 1 and 50/);
  assert.throws(() => assertMaxFeatured(51), /between 1 and 50/);
  assert.throws(() => assertMaxFeatured(10.5), /whole number/);
});
