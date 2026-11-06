// Unit tests for the new-user hat's pure geometry and visibility rule (SKILLY_SPEC.md §66.3).
// Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HAT_VIEW_HEIGHT, HAT_VIEW_WIDTH, hatGeometry, showHat } from "./hatGeometry";
import { ringGeometry } from "./levelRing";

test("hatGeometry: floored so the beanie survives the smallest avatars", () => {
  for (const base of [8, 12, 16, 20]) assert.equal(hatGeometry(base).width, 12, `base ${base}`);
});

test("hatGeometry: scales with the bubble and keeps the SVG's aspect ratio", () => {
  const small = hatGeometry(28);
  const large = hatGeometry(52);
  assert.ok(large.width > small.width);
  for (const g of [small, large, hatGeometry(ringGeometry(52).outer)]) {
    assert.ok(Math.abs(g.height / g.width - HAT_VIEW_HEIGHT / HAT_VIEW_WIDTH) < 0.05, JSON.stringify(g));
  }
});

test("hatGeometry: overflows above the bubble but still rests on it", () => {
  for (const base of [20, 28, 40, 52, 64]) {
    const g = hatGeometry(base);
    assert.ok(g.top < 0, "the hat rises above the bubble's top edge");
    assert.ok(-g.top < g.height, "part of the hat sits on the bubble, as if worn");
  }
});

test("showHat: a new user who isn't a Hero; never without a user id", () => {
  assert.equal(showHat("u1", ["u1", "u2"], false), true);
  assert.equal(showHat("u1", ["u1"], true), false); // the crown takes the spot
  assert.equal(showHat("u3", ["u1", "u2"], false), false);
  assert.equal(showHat("u1", undefined, false), false); // the map hasn't loaded yet
  assert.equal(showHat(null, ["u1"], false), false);
  assert.equal(showHat(undefined, [], false), false);
});
