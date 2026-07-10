import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidSemver,
  channelOf,
  compareSemver,
  resolveLatest,
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

test("strictly increasing enforced", () => {
  assert.throws(() => assertStrictlyIncreasing("1.0.0", ["1.0.0"]));
  assert.throws(() => assertStrictlyIncreasing("1.0.0", ["1.1.0"]));
  assert.doesNotThrow(() => assertStrictlyIncreasing("1.2.0", ["1.1.0", "1.0.0"]));
});
