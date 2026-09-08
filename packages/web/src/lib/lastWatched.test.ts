// Unit tests for the last-watched card rules (SKILLY_SPEC.md §5 / §30.6). The behaviors under test
// are the ones an admin would notice as wrong: a collapse that silently re-expands next visit, an
// arrival that fights the URL's own anchor or the user's own scrolling, a retired card id that
// keeps a stale key alive.
import test from "node:test";
import assert from "node:assert/strict";
import { afterToggle, planArrival, needsScroll } from "./lastWatched";

test("expanding a card remembers it", () => {
  assert.equal(afterToggle(null, "upload", true), "upload");
  assert.equal(afterToggle("scim", "upload", true), "upload");
});

test("collapsing never counts as watching", () => {
  // Collapsing some other card leaves the remembered one alone.
  assert.equal(afterToggle("scim", "upload", false), "scim");
  assert.equal(afterToggle(null, "upload", false), null);
});

test("collapsing the remembered card clears it", () => {
  assert.equal(afterToggle("upload", "upload", false), null);
});

test("arrival with nothing remembered does nothing", () => {
  assert.deepEqual(planArrival({ stored: null, rendered: ["a"], hash: "", scrollY: 0 }), { kind: "none" });
  assert.deepEqual(planArrival({ stored: "", rendered: ["a"], hash: "", scrollY: 0 }), { kind: "none" });
});

test("a URL hash wins over the remembered card, and the key is kept", () => {
  assert.deepEqual(planArrival({ stored: "a", rendered: ["a"], hash: "#online", scrollY: 0 }), { kind: "none" });
  // A bare "#" is not an anchor.
  assert.deepEqual(planArrival({ stored: "a", rendered: ["a"], hash: "#", scrollY: 0 }), { kind: "arrive", id: "a" });
});

test("scrolling before the data gate resolves skips the whole arrival", () => {
  assert.deepEqual(planArrival({ stored: "a", rendered: ["a"], hash: "", scrollY: 1 }), { kind: "none" });
  assert.deepEqual(planArrival({ stored: "a", rendered: ["a"], hash: "", scrollY: 480 }), { kind: "none" });
});

test("a remembered id that names no rendered card is cleared", () => {
  assert.deepEqual(planArrival({ stored: "retired", rendered: ["a", "b"], hash: "", scrollY: 0 }), { kind: "clear" });
  assert.deepEqual(planArrival({ stored: "ns-gone", rendered: [], hash: "", scrollY: 0 }), { kind: "clear" });
});

test("a remembered, rendered card arrives", () => {
  assert.deepEqual(planArrival({ stored: "b", rendered: ["a", "b"], hash: "", scrollY: 0 }), { kind: "arrive", id: "b" });
});

test("the scroll motion is dropped only when the header is fully in view", () => {
  assert.equal(needsScroll({ top: 100, bottom: 160 }, 800), false);
  assert.equal(needsScroll({ top: 0, bottom: 60 }, 800), false);
  assert.equal(needsScroll({ top: 740, bottom: 800 }, 800), false);
  // Partly or wholly off-screen, either edge.
  assert.equal(needsScroll({ top: -5, bottom: 55 }, 800), true);
  assert.equal(needsScroll({ top: 780, bottom: 840 }, 800), true);
  assert.equal(needsScroll({ top: 2000, bottom: 2060 }, 800), true);
});
