import { test } from "node:test";
import assert from "node:assert/strict";
import { whatsNewAction, validateSeenVersion, countNewSince } from "./whats-new.js";

test("whatsNewAction: never for a user who has not completed Quick start", () => {
  assert.equal(whatsNewAction(null, "1.149.0", false), "none");
  assert.equal(whatsNewAction("1.100.0", "1.149.0", false), "none");
});

test("whatsNewAction: a never-stamped onboarded user gets the toast (roll-out case)", () => {
  assert.equal(whatsNewAction(null, "1.149.0", true), "toast");
  assert.equal(whatsNewAction(undefined, "1.149.0", true), "toast");
});

test("whatsNewAction: minor and major bumps toast, patch-only bumps advance silently", () => {
  assert.equal(whatsNewAction("1.148.1", "1.149.0", true), "toast");
  assert.equal(whatsNewAction("1.148.1", "2.0.0", true), "toast");
  assert.equal(whatsNewAction("1.149.0", "1.149.1", true), "advance");
  assert.equal(whatsNewAction("1.149.0", "1.149.7", true), "advance");
  // Several skipped patches then a minor: exactly one toast.
  assert.equal(whatsNewAction("1.148.0", "1.149.3", true), "toast");
});

test("whatsNewAction: equal, rollback and stale bundle show nothing", () => {
  assert.equal(whatsNewAction("1.149.0", "1.149.0", true), "none");
  assert.equal(whatsNewAction("1.150.0", "1.149.0", true), "none");
  assert.equal(whatsNewAction("2.0.0", "1.149.9", true), "none");
});

test("whatsNewAction: invalid inputs", () => {
  assert.equal(whatsNewAction("1.148.0", "not-a-version", true), "none");
  // A corrupt stored marker is treated as never stamped.
  assert.equal(whatsNewAction("garbage", "1.149.0", true), "toast");
});

test("validateSeenVersion: valid, at or below the server version", () => {
  assert.equal(validateSeenVersion("1.149.0", "1.149.0"), "1.149.0");
  assert.equal(validateSeenVersion(" 1.148.2 ", "1.149.0"), "1.148.2");
  assert.equal(validateSeenVersion("1.149.1", "1.149.0"), null); // the future
  assert.equal(validateSeenVersion("v1.149.0", "1.149.0"), null);
  assert.equal(validateSeenVersion(42, "1.149.0"), null);
  assert.equal(validateSeenVersion(undefined, "1.149.0"), null);
});

test("countNewSince: leading newer entries of a newest-first changelog", () => {
  const log = ["1.149.0", "1.148.1", "1.148.0", "1.147.1", "1.147.0"];
  assert.equal(countNewSince(log, "1.148.0", "1.149.0"), 2);
  assert.equal(countNewSince(log, "1.147.0", "1.149.0"), 4);
  assert.equal(countNewSince(log, "1.0.0", "1.149.0"), 5); // older than everything → all new
  assert.equal(countNewSince(log, "1.149.0", "1.149.0"), 0); // not lower than current
  assert.equal(countNewSince(log, "1.150.0", "1.149.0"), 0); // rollback
  assert.equal(countNewSince(log, null, "1.149.0"), 0);
  assert.equal(countNewSince(log, "nope", "1.149.0"), 0);
  assert.equal(countNewSince(["1.149.0", "bad", "1.148.0"], "1.147.0", "1.149.0"), 2);
});
