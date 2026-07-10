import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHarness, validateHarness } from "./harness.js";

test("normalizeHarness collapses case and whitespace to seeded kebab style", () => {
  assert.equal(normalizeHarness("Claude Desktop"), "claude-desktop");
  assert.equal(normalizeHarness("  Cursor "), "cursor");
  assert.equal(normalizeHarness("GPT  4.1"), "gpt-4.1");
  assert.equal(normalizeHarness("claude-code"), "claude-code");
});

test("validateHarness accepts seeded-style and dotted/plus names", () => {
  for (const v of ["claude-code", "generic", "gpt-4.1", "c++", "windsurf"]) {
    assert.equal(validateHarness(v), null, v);
  }
});

test("validateHarness rejects empty, long, and bad charset", () => {
  assert.ok(validateHarness(""));
  assert.ok(validateHarness("x".repeat(41)));
  assert.ok(validateHarness("-leading-dash"));
  assert.ok(validateHarness("has_underscore"));
  assert.ok(validateHarness("Uppercase")); // validate runs on NORMALIZED input
  assert.ok(validateHarness("semi;colon"));
});
