import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidSemver,
  channelOf,
  compareSemver,
  resolveLatest,
  resolvePredecessor,
  assertStrictlyIncreasing,
} from "./semver.js";

test("validates semver", () => {
  assert.ok(isValidSemver("1.2.3"));
  assert.ok(isValidSemver("1.2.3-beta.1"));
  assert.ok(!isValidSemver("1.2"));
  assert.ok(!isValidSemver("v1.2.3"));
});

test("channel derives from prerelease", () => {
  assert.equal(channelOf("1.0.0"), "stable");
  assert.equal(channelOf("1.0.0-beta.2"), "beta");
});

test("prerelease precedes its release", () => {
  assert.equal(compareSemver("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("1.2.0", "1.1.9"), 1);
});

test("latest = highest stable active", () => {
  assert.equal(resolveLatest(["1.0.0", "1.1.0-beta.1", "0.9.0"]), "1.0.0");
  assert.equal(resolveLatest(["1.0.0-beta.1"]), null);
});

// The baseline for a published version's file-change view (§10): the version immediately below
// it — channel- and status-blind, so a beta or a yanked version still counts as the predecessor.
test("predecessor = the version immediately below, any channel", () => {
  const all = ["1.0.0", "1.0.1", "1.1.0-beta.1", "1.1.0", "0.9.0"];
  assert.equal(resolvePredecessor("1.1.0", all), "1.1.0-beta.1", "a prerelease counts as the predecessor");
  assert.equal(resolvePredecessor("1.1.0-beta.1", all), "1.0.1");
  assert.equal(resolvePredecessor("1.0.1", all), "1.0.0");
  assert.equal(resolvePredecessor("1.0.0", all), "0.9.0");
});

test("the lowest version has no predecessor (a skill's first version)", () => {
  assert.equal(resolvePredecessor("0.9.0", ["1.0.0", "0.9.0"]), null);
  assert.equal(resolvePredecessor("1.0.0", ["1.0.0"]), null, "itself never counts");
  assert.equal(resolvePredecessor("1.0.0", []), null);
});

test("predecessor ignores unparseable entries and an invalid target", () => {
  assert.equal(resolvePredecessor("2.0.0", ["1.0.0", "not-a-version", "v1.5.0"]), "1.0.0");
  assert.equal(resolvePredecessor("bogus", ["1.0.0"]), null);
});

test("strictly increasing enforced", () => {
  assert.throws(() => assertStrictlyIncreasing("1.0.0", ["1.0.0"]));
  assert.throws(() => assertStrictlyIncreasing("1.0.0", ["1.1.0"]));
  assert.doesNotThrow(() => assertStrictlyIncreasing("1.2.0", ["1.1.0", "1.0.0"]));
});
