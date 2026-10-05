// Unit tests for installed-version freshness (SKILLY_SPEC.md §23, §37.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveFreshness, isBehindLatest, refreshHint } from "./freshness.js";

const ACTIVE = ["1.0.0", "1.1.0", "1.2.0", "1.3.0-beta.1"];

test("freshness: current when the served version is latest stable", () => {
  assert.deepEqual(deriveFreshness({ lastServedSemver: "1.2.0", activeSemvers: ACTIVE }), { freshness: "current", latestSemver: "1.2.0" });
});

test("freshness: behind when older than latest stable (pinned-by-choice included)", () => {
  assert.deepEqual(deriveFreshness({ lastServedSemver: "1.0.0", activeSemvers: ACTIVE }), { freshness: "behind", latestSemver: "1.2.0" });
  assert.equal(deriveFreshness({ lastServedSemver: "1.1.0", activeSemvers: ACTIVE }).freshness, "behind");
});

test("freshness: betas never make anything behind", () => {
  // A pinned beta NEWER than latest stable is not behind.
  assert.equal(deriveFreshness({ lastServedSemver: "1.3.0-beta.1", activeSemvers: ACTIVE }).freshness, "current");
  // A newer beta does not pull latest forward: served 1.2.0 stays current even with 1.3.0-beta.1 active.
  assert.equal(deriveFreshness({ lastServedSemver: "1.2.0", activeSemvers: ACTIVE }).latestSemver, "1.2.0");
  // An OLDER pinned beta is behind (it is older than latest stable, not newer).
  assert.equal(deriveFreshness({ lastServedSemver: "1.1.0-beta.2", activeSemvers: [...ACTIVE, "1.1.0-beta.2"] }).freshness, "behind");
});

test("freshness: withdrawn when the served version is no longer active (yanked or deleted)", () => {
  // Yanked rows are excluded from the active list by the caller — absence IS withdrawal.
  const r = deriveFreshness({ lastServedSemver: "1.1.0", activeSemvers: ["1.0.0", "1.2.0"] });
  assert.deepEqual(r, { freshness: "withdrawn", latestSemver: "1.2.0" });
  // Even a withdrawn version that would compare EQUAL/HIGHER to latest is withdrawn, not current.
  assert.equal(deriveFreshness({ lastServedSemver: "2.0.0", activeSemvers: ["1.0.0"] }).freshness, "withdrawn");
});

test("freshness: unknown when there is no stamp, or no latest stable", () => {
  assert.deepEqual(deriveFreshness({ lastServedSemver: null, activeSemvers: ACTIVE }), { freshness: "unknown", latestSemver: "1.2.0" });
  // Only betas active → no latest → unknown, never behind, whatever was served.
  assert.deepEqual(deriveFreshness({ lastServedSemver: "1.0.0-beta.1", activeSemvers: ["1.0.0-beta.1"] }), { freshness: "unknown", latestSemver: null });
  // Nothing active at all.
  assert.deepEqual(deriveFreshness({ lastServedSemver: "1.0.0", activeSemvers: [] }), { freshness: "unknown", latestSemver: null });
  // A garbage stamp is unknown rather than a thrown compare.
  assert.equal(deriveFreshness({ lastServedSemver: "not-a-version", activeSemvers: ACTIVE }).freshness, "unknown");
});

test("freshness: the Behind-latest filter keeps behind AND withdrawn, nothing else", () => {
  assert.equal(isBehindLatest("behind"), true);
  assert.equal(isBehindLatest("withdrawn"), true);
  assert.equal(isBehindLatest("current"), false);
  assert.equal(isBehindLatest("unknown"), false);
});

test("refresh hint: rerun for latest-tracking, reinstall (with the target semver) for pinned", () => {
  assert.deepEqual(refreshHint("behind", false, "1.2.0"), { action: "rerun" });
  assert.deepEqual(refreshHint("behind", true, "1.2.0"), { action: "reinstall", semver: "1.2.0" });
  assert.deepEqual(refreshHint("withdrawn", true, "1.2.0"), { action: "reinstall", semver: "1.2.0" });
  assert.deepEqual(refreshHint("withdrawn", false, "1.2.0"), { action: "rerun" });
  // Nothing to do when current/unknown, or when there is no latest to move to.
  assert.equal(refreshHint("current", false, "1.2.0"), null);
  assert.equal(refreshHint("unknown", true, "1.2.0"), null);
  assert.equal(refreshHint("behind", true, null), null);
});
