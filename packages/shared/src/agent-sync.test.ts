import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_KEY_TTL_HOURS_DEFAULT,
  AGENT_KEY_TTL_HOURS_MAX,
  parseAgentKeyTtlHours,
  recordAgentClone,
} from "./agent-sync.js";

test("agent key TTL: unset and blank take the default silently", () => {
  assert.deepEqual(parseAgentKeyTtlHours(undefined), { hours: AGENT_KEY_TTL_HOURS_DEFAULT, warning: null });
  assert.deepEqual(parseAgentKeyTtlHours("  "), { hours: 12, warning: null });
});

test("agent key TTL: 1..24 are taken as given", () => {
  assert.deepEqual(parseAgentKeyTtlHours("1"), { hours: 1, warning: null });
  assert.deepEqual(parseAgentKeyTtlHours(" 12 "), { hours: 12, warning: null });
  assert.deepEqual(parseAgentKeyTtlHours("24"), { hours: 24, warning: null });
});

test("agent key TTL: above 24 is clamped to 24 with a warning", () => {
  const r = parseAgentKeyTtlHours("25");
  assert.equal(r.hours, AGENT_KEY_TTL_HOURS_MAX);
  assert.match(r.warning ?? "", /SKILLY_AGENT_KEY_TTL_HOURS/);
  assert.equal(parseAgentKeyTtlHours("9999").hours, 24);
});

test("agent key TTL: zero, negative, fractional and non-numeric take the default with a warning", () => {
  for (const bad of ["0", "-3", "1.5", "abc", "12h"]) {
    const r = parseAgentKeyTtlHours(bad);
    assert.equal(r.hours, 12, bad);
    assert.match(r.warning ?? "", /SKILLY_AGENT_KEY_TTL_HOURS/, bad);
  }
});

test("recordAgentClone: stamps the latest STABLE active version and logs the fetch as 'aion'", async () => {
  const calls: { text: string; params: unknown[] }[] = [];
  const db = {
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      // First statement reads the skill's active versions; a beta must not win.
      return { rows: calls.length === 1 ? [{ semver: "1.0.0" }, { semver: "1.2.0" }, { semver: "2.0.0-beta.1" }] : [] };
    },
  };
  await recordAgentClone(db, { userId: "u1", skillId: "s1", userAgent: "git/2.45.0", clientIp: "10.0.0.7" });
  assert.equal(calls.length, 2);
  const write = calls[1]!;
  assert.deepEqual(write.params, ["u1", "s1", "aion", "1.2.0", "git/2.45.0", "10.0.0.7"]);
  assert.match(write.text, /insert into agent_installs/);
  assert.match(write.text, /on conflict \(user_id, skill_id, source\) do update/);
  assert.match(write.text, /insert into access_log/);
  // Never the adoption path (§69.7): no ledger, no counter, no credit.
  assert.doesNotMatch(write.text, /record_git_access|skill_installs|install_count|install_credits|install_counters/);
});

test("recordAgentClone: no stable active version stamps NULL", async () => {
  const params: unknown[][] = [];
  const db = {
    async query(_text: string, p: unknown[] = []) {
      params.push(p);
      return { rows: params.length === 1 ? [{ semver: "0.1.0-beta.1" }] : [] };
    },
  };
  await recordAgentClone(db, { userId: "u1", skillId: "s1", userAgent: null, clientIp: null });
  assert.equal(params[1]![3], null);
});
