// The §40.14 AI display name: validation and the served value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_DISPLAY_NAME_DEFAULT, coerceAiDisplayName, validateAiDisplayName } from "./ai-name.js";
import { qualityModeLine } from "./quality-status.js";

test("validateAiDisplayName: trims, empty restores the default, 24-character cap", () => {
  assert.deepEqual(validateAiDisplayName("  Aria  "), { ok: true, value: "Aria" });
  assert.deepEqual(validateAiDisplayName(""), { ok: true, value: "" });
  assert.deepEqual(validateAiDisplayName(null), { ok: true, value: "" });
  assert.equal(validateAiDisplayName("x".repeat(24)).ok, true);
  assert.equal(validateAiDisplayName("x".repeat(25)).ok, false);
  // Code points, not UTF-16 units: 24 emoji are fine.
  assert.equal(validateAiDisplayName("🤖".repeat(24)).ok, true);
});

test("validateAiDisplayName: rejects non-strings, control characters and line breaks", () => {
  assert.equal(validateAiDisplayName(42).ok, false);
  assert.equal(validateAiDisplayName(`Ar${String.fromCharCode(10)}ia`).ok, false);
  assert.equal(validateAiDisplayName(`Ar${String.fromCharCode(7)}ia`).ok, false);
  assert.equal(validateAiDisplayName(`Ar${String.fromCharCode(0x2028)}ia`).ok, false);
});

test("coerceAiDisplayName: a valid stored name, else AI", () => {
  assert.equal(coerceAiDisplayName("Aria"), "Aria");
  assert.equal(coerceAiDisplayName(undefined), AI_DISPLAY_NAME_DEFAULT);
  assert.equal(coerceAiDisplayName(""), "AI");
  assert.equal(coerceAiDisplayName("x".repeat(30)), "AI");
  assert.equal(coerceAiDisplayName(12), "AI");
});

test("qualityModeLine uses the display name (§40.14) and defaults to AI", () => {
  assert.equal(qualityModeLine("rules+ai", "done", "m1", "Aria"), "Rules + Aria assessment (m1)");
  assert.equal(qualityModeLine("rules", "pending", null, "Aria"), "Rules only — Aria assessment pending");
  assert.equal(qualityModeLine("rules", "failed", null), "Rules only — AI assessment unavailable");
  assert.equal(qualityModeLine("rules", "off", null, "Aria"), "Rules only");
});
