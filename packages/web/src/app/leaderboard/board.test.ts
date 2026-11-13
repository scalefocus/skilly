// Unit test for the People board's vocabulary (SKILLY_SPEC.md §21 "Sort and row" / "Row layout"):
// Installed leads the toggle and is the page's default, the captions are one short word each, and
// the stat line starts with skills installed so the headline number is never the part cut off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SORT, LB_COMPACT_BELOW, LB_MAX_BADGES, LB_MAX_BADGES_COMPACT, SORTS, avatarSlot, isCompactBoard, statLine, type Entry } from "./board";

function entry(over: Partial<Entry> = {}): Entry {
  return {
    userId: "u", displayName: "U", email: "u@org", avatar: null,
    skillCount: 0, installs: 0, requestsFulfilled: 0, skillsWatched: 0, skillsRequested: 0,
    followers: 0, collections: 0, skillsInstalled: 0, followable: true,
    ...over,
  };
}

test("the toggle opens on Installed, with Installs received second and the rest in their old order", () => {
  assert.equal(DEFAULT_SORT, "installed");
  assert.equal(SORTS[0]!.key, DEFAULT_SORT);
  assert.deepEqual(
    SORTS.map((s) => s.label),
    ["Installed", "Installs received", "Skills adopted", "Requests fulfilled", "Watched", "Requested", "Followed", "Curated"],
  );
  assert.deepEqual(
    SORTS.map((s) => s.key),
    ["installed", "installs", "skills", "requests", "watched", "requested", "followed", "curated"],
  );
});

test("captions are one short word each, and each sort reads its own number", () => {
  assert.deepEqual(
    SORTS.map((s) => s.caption),
    ["installed", "installs", "adopted", "fulfilled", "watched", "requested", "followers", "collections"],
  );
  const e = entry({ skillsInstalled: 1, installs: 2, skillCount: 3, requestsFulfilled: 4, skillsWatched: 5, skillsRequested: 6, followers: 7, collections: 8 });
  assert.deepEqual(SORTS.map((s) => s.value(e)), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("isCompactBoard (§21 'Narrow screens'): a board under 760 px of its own width uses the three-band rows", () => {
  assert.equal(LB_COMPACT_BELOW, 760);
  assert.equal(isCompactBoard(339), true, "a 375 px phone");
  assert.equal(isCompactBoard(682), true, "a 1024 px window with the sidebar open");
  assert.equal(isCompactBoard(759), true);
  assert.equal(isCompactBoard(760), false);
  assert.equal(isCompactBoard(980), false, "the full-width board");
});

test("avatarSlot: one height for every row; a narrow board's 2-badge slot is narrower than the 4-badge one", () => {
  assert.equal(LB_MAX_BADGES, 4);
  assert.equal(LB_MAX_BADGES_COMPACT, 2);
  const wide = avatarSlot(LB_MAX_BADGES);
  const narrow = avatarSlot(LB_MAX_BADGES_COMPACT);
  assert.deepEqual(wide, { width: 90, height: 58 });
  assert.deepEqual(narrow, { width: 58, height: 58 });
  // Never narrower than the ringed bubble, even with no badge room at all.
  assert.equal(avatarSlot(0).width, 42);
});

test("statLine: skills installed leads; skills adopted always shows; zero stats are left out", () => {
  assert.equal(
    statLine(entry({ skillsInstalled: 70, skillCount: 0, followers: 2 })),
    "70 skills installed · 0 skills adopted · 2 followers",
  );
  assert.equal(
    statLine(entry({ skillsInstalled: 12, skillCount: 58, requestsFulfilled: 3, skillsWatched: 5, skillsRequested: 2, followers: 1, collections: 4 })),
    "12 skills installed · 58 skills adopted · 3 requests fulfilled · 5 skills watched · 2 skills requested · 1 follower · 4 collections",
  );
  // Nothing installed: the line starts with skills adopted, as before.
  assert.equal(statLine(entry({ skillCount: 4 })), "4 skills adopted");
  // Singulars.
  assert.equal(
    statLine(entry({ skillsInstalled: 1, skillCount: 1, requestsFulfilled: 1, skillsWatched: 1, skillsRequested: 1, collections: 1 })),
    "1 skill installed · 1 skill adopted · 1 request fulfilled · 1 skill watched · 1 skill requested · 1 collection",
  );
});
