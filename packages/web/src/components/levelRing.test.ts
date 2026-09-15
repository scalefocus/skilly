// Level-ring geometry (SKILLY_SPEC.md §31.10): the sizing rules that have to hold across every
// bubble size the app actually renders, and the omitted-at-0 rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ringDashArray, ringGeometry, showRing } from "./levelRing";

/** Every `size` a <UserBubble> is given anywhere in the app today. */
const SIZES_IN_USE = [20, 22, 24, 26, 28, 30, 34, 40, 52];

test("showRing: level 0 draws nothing — a badge-less bubble is unchanged by this feature", () => {
  assert.equal(showRing(0), false);
  assert.equal(showRing(1), true);
  assert.equal(showRing(20), true);
});

test("ringGeometry: the stroke is floored so the ring survives the smallest bubbles", () => {
  // 20 * 0.08 = 1.6 → would round to 2 anyway, but the floor is what guarantees it can never
  // round to 1 (or 0) if the proportion is ever retuned downwards.
  assert.equal(ringGeometry(20).stroke, 2);
  assert.equal(ringGeometry(22).stroke, 2);
  for (const size of SIZES_IN_USE) {
    assert.ok(ringGeometry(size).stroke >= 2, `stroke too thin at ${size}px`);
  }
});

test("ringGeometry: the stroke scales with the bubble, so a 52px ring isn't hairline", () => {
  assert.ok(ringGeometry(52).stroke > ringGeometry(20).stroke);
  assert.equal(ringGeometry(52).stroke, 4);
});

test("ringGeometry: the avatar keeps its own size — only the ring's width is added", () => {
  for (const size of SIZES_IN_USE) {
    const g = ringGeometry(size);
    // Footprint = the avatar plus the arc on both sides plus a 1px gap each side. The avatar is
    // never shrunk to fit inside, so no photo is cropped and no initials become unreadable.
    assert.equal(g.outer, size + 2 * (g.stroke + 1));
    assert.ok(g.outer > size);
    // The arc is stroked ON the radius, so half of it sits inside `outer` — it never clips.
    assert.equal(g.radius, (g.outer - g.stroke) / 2);
    assert.equal(g.center, g.outer / 2);
  }
});

test("ringDashArray: the filled arc is level/total of the circumference", () => {
  const g = ringGeometry(40);
  const [filled, rest] = ringDashArray(g, 10, false, 20).split(" ").map(Number);
  assert.ok(Math.abs(filled! - g.circumference / 2) < 1e-9);
  assert.ok(Math.abs(rest! - g.circumference) < 1e-9);
  // Level 0 would draw an empty arc — showRing keeps it off the page entirely, but the maths holds.
  assert.equal(ringDashArray(g, 0, false, 20).split(" ")[0], "0");
});

test("ringDashArray: a Hero's ring is full even after the catalog grows past their tally", () => {
  const g = ringGeometry(34);
  const filled = Number(ringDashArray(g, 20, true, 25).split(" ")[0]);
  assert.ok(Math.abs(filled - g.circumference) < 1e-9, "a Hero ring must stay complete");
  // Same tally without the stamp: honestly short of the bigger catalog.
  assert.ok(Number(ringDashArray(g, 20, false, 25).split(" ")[0]) < g.circumference);
});
