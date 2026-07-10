import { test } from "node:test";
import assert from "node:assert/strict";
import { isAgentSlug, agentLabel, isAllowedToolHarness, TOOL_OPTIONS, GENERIC_AGENT } from "./agents.js";

test("isAgentSlug: recognized non-generic only", () => {
  assert.equal(isAgentSlug("cursor"), true);
  assert.equal(isAgentSlug("claude-code"), true);
  assert.equal(isAgentSlug("generic"), false);
  assert.equal(isAgentSlug("totally-made-up"), false);
  assert.equal(isAgentSlug(null), false);
  assert.equal(isAgentSlug(""), false);
});

test("agentLabel: label for known, Generic for generic/empty, raw for legacy", () => {
  assert.equal(agentLabel("cursor"), "Cursor");
  assert.equal(agentLabel("inference-sh"), "inference.sh");
  assert.equal(agentLabel("generic"), "Generic");
  assert.equal(agentLabel(null), "Generic");
  assert.equal(agentLabel("claude-desktop"), "claude-desktop"); // legacy value not in the list
});

test("isAllowedToolHarness: generic ∪ known slugs", () => {
  assert.equal(isAllowedToolHarness("generic"), true);
  assert.equal(isAllowedToolHarness("windsurf"), true);
  assert.equal(isAllowedToolHarness("claude-desktop"), false);
});

test("TOOL_OPTIONS: Generic first, then alphabetical by label, no dupes", () => {
  assert.equal(TOOL_OPTIONS[0]!.slug, GENERIC_AGENT);
  const rest = TOOL_OPTIONS.slice(1).map((o) => o.label);
  assert.deepEqual(rest, [...rest].sort((a, b) => a.localeCompare(b)));
  const slugs = TOOL_OPTIONS.map((o) => o.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});
