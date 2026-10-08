// Policy rules — the pure half (SKILLY_SPEC.md §47.3, §47.7, §47.8).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  POLICY_BODY_MAX,
  POLICY_CONTEXT_MAX,
  POLICY_TITLE_MAX,
  canOverridePolicyScope,
  policyGateTrips,
  policyPublishRoute,
  policyTitleKey,
  policyVersionStatus,
  sortPolicyResults,
  validatePolicyRuleText,
  type PolicyGateRule,
  type PolicyGateVerdict,
} from "./policy.js";

const rule = (id: string, over: Partial<PolicyGateRule> = {}): PolicyGateRule => ({
  id,
  scope: "namespace",
  state: "enforced",
  revisionId: `${id}-r1`,
  title: `Rule ${id}`,
  ...over,
});
const done = (...results: [string, string, PolicyGateVerdict["results"][number]["outcome"]][]): PolicyGateVerdict => ({
  status: "done",
  results: results.map(([ruleId, revisionId, outcome]) => ({ ruleId, revisionId, outcome })),
});

test("validatePolicyRuleText: trims, collapses the title, caps every field", () => {
  const ok = validatePolicyRuleText({ title: "  No   external\nAPIs ", body: " Rule\r\nbody ", context: "  " });
  assert.deepEqual(ok, { ok: true, value: { title: "No external APIs", body: "Rule\nbody", context: null } });
  assert.equal((validatePolicyRuleText({ title: "", body: "x" }) as { code: string }).code, "title_required");
  assert.equal((validatePolicyRuleText({ title: "t", body: "  " }) as { code: string }).code, "body_required");
  assert.equal((validatePolicyRuleText({ title: "x".repeat(POLICY_TITLE_MAX + 1), body: "b" }) as { code: string }).code, "title_too_long");
  assert.equal((validatePolicyRuleText({ title: "t", body: "b".repeat(POLICY_BODY_MAX + 1) }) as { code: string }).code, "body_too_long");
  assert.equal((validatePolicyRuleText({ title: "t", body: "b", context: "c".repeat(POLICY_CONTEXT_MAX + 1) }) as { code: string }).code, "context_too_long");
  assert.ok(validatePolicyRuleText({ title: "x".repeat(POLICY_TITLE_MAX), body: "b".repeat(POLICY_BODY_MAX), context: "c".repeat(POLICY_CONTEXT_MAX) }).ok);
  assert.equal(policyTitleKey("  No  External APIs"), policyTitleKey("no external apis"));
});

test("gate: no enforced rule never trips — not even with the AI off or no verdict", () => {
  assert.deepEqual(policyGateTrips([], null, { noVerdict: "off" }), []);
  assert.deepEqual(policyGateTrips([rule("a", { state: "shadow" })], null, { noVerdict: "unavailable" }), []);
});

test("gate: no verdict trips every enforced rule — pending, off, unavailable, skipped, failed", () => {
  const rules = [rule("a"), rule("b", { scope: "platform" }), rule("c", { state: "shadow" })];
  assert.deepEqual(policyGateTrips(rules, null, { noVerdict: "pending" }).map((t) => [t.ruleId, t.reason]), [["a", "pending"], ["b", "pending"]]);
  for (const why of ["off", "unavailable", "skipped"] as const) {
    assert.deepEqual(policyGateTrips(rules, null, { noVerdict: why }).map((t) => t.reason), [why, why]);
  }
  // A queued run reads pending whatever the switch says.
  assert.deepEqual(policyGateTrips(rules, { status: "pending", results: [] }, { noVerdict: "off" }).map((t) => t.reason), ["pending", "pending"]);
  assert.deepEqual(policyGateTrips(rules, { status: "failed", results: [] }, { noVerdict: "pending" }).map((t) => t.reason), ["failed", "failed"]);
});

test("gate: a violation of an enforced rule trips; shadow and disabled never do", () => {
  const rules = [rule("a"), rule("s", { state: "shadow" }), rule("d", { state: "disabled" })];
  const v = done(["a", "a-r1", "violates"], ["s", "s-r1", "violates"], ["d", "d-r1", "violates"]);
  assert.deepEqual(policyGateTrips(rules, v, { noVerdict: "pending" }).map((t) => [t.ruleId, t.reason]), [["a", "violates"]]);
  // A rule moved to Shadow after judging no longer trips.
  assert.deepEqual(policyGateTrips([rule("a", { state: "shadow" })], v, { noVerdict: "pending" }), []);
});

test("gate: uncertain / complies / not_applicable pass; a result at an old revision is stale", () => {
  const rules = [rule("a"), rule("b"), rule("c")];
  assert.deepEqual(policyGateTrips(rules, done(["a", "a-r1", "uncertain"], ["b", "b-r1", "complies"], ["c", "c-r1", "not_applicable"]), { noVerdict: "pending" }), []);
  const edited = [rule("a", { revisionId: "a-r2" })];
  assert.deepEqual(policyGateTrips(edited, done(["a", "a-r1", "complies"]), { noVerdict: "pending" }).map((t) => t.reason), ["stale"]);
  // An enforced rule the verdict never judged (enforced later) is stale too.
  assert.deepEqual(policyGateTrips([rule("z")], done(), { noVerdict: "pending" }).map((t) => t.reason), ["stale"]);
});

test("override authority: platform rules → platform admins only", () => {
  assert.equal(canOverridePolicyScope("platform", { platformAdmin: false, namespaceAdmin: true }), false);
  assert.equal(canOverridePolicyScope("platform", { platformAdmin: true, namespaceAdmin: false }), true);
  assert.equal(canOverridePolicyScope("namespace", { platformAdmin: false, namespaceAdmin: true }), true);
  assert.equal(canOverridePolicyScope("namespace", { platformAdmin: false, namespaceAdmin: false }), false);
});

test("direct publish routing: through only when the publisher could override every enforced rule", () => {
  const member = { platformAdmin: false, namespaceAdmin: false };
  const nsAdmin = { platformAdmin: false, namespaceAdmin: true };
  const platform = { platformAdmin: true, namespaceAdmin: false };
  assert.equal(policyPublishRoute([], member), "through");
  assert.equal(policyPublishRoute([rule("s", { state: "shadow" })], member), "through");
  assert.equal(policyPublishRoute([rule("a")], member), "route");
  assert.equal(policyPublishRoute([rule("a")], nsAdmin), "through");
  assert.equal(policyPublishRoute([rule("a"), rule("p", { scope: "platform" })], nsAdmin), "route");
  assert.equal(policyPublishRoute([rule("p", { scope: "platform", state: "shadow" })], nsAdmin), "through");
  assert.equal(policyPublishRoute([rule("a"), rule("p", { scope: "platform" })], platform), "through");
});

test("version status (§46.8): none / pending / clear / noted / flagged", () => {
  const rules = [rule("a"), rule("b")];
  assert.equal(policyVersionStatus([rule("s", { state: "shadow" })], null, []).status, "none");
  assert.equal(policyVersionStatus(rules, null, []).status, "pending");
  assert.equal(policyVersionStatus(rules, { status: "failed", results: [] }, []).status, "pending");
  assert.equal(policyVersionStatus(rules, done(["a", "a-r1", "complies"], ["b", "b-r1", "uncertain"]), []).status, "clear");
  const v = done(["a", "a-r1", "violates"], ["b", "b-r1", "complies"]);
  const flagged = policyVersionStatus(rules, v, []);
  assert.equal(flagged.status, "flagged");
  assert.deepEqual(flagged.violated.map((r) => r.id), ["a"]);
  assert.equal(policyVersionStatus(rules, v, [{ ruleId: "a", revisionId: "a-r1" }]).status, "noted");
  // A dismissal at an OLD revision doesn't cover a violation of the current wording.
  const edited = [rule("a", { revisionId: "a-r2" }), rule("b")];
  assert.equal(policyVersionStatus(edited, done(["a", "a-r2", "violates"], ["b", "b-r1", "complies"]), [{ ruleId: "a", revisionId: "a-r1" }]).status, "flagged");
  // Stale results read as pending unless something is already flagged.
  assert.equal(policyVersionStatus(edited, done(["a", "a-r1", "complies"], ["b", "b-r1", "complies"]), []).status, "pending");
  assert.equal(policyVersionStatus(edited, done(["a", "a-r1", "complies"], ["b", "b-r1", "violates"]), []).status, "flagged");
  // A violated rule since disabled stops counting.
  assert.equal(policyVersionStatus([rule("a", { state: "disabled" }), rule("b")], v, []).status, "clear");
});

test("sortPolicyResults: violations, uncertain, complies, not applicable", () => {
  const sorted = sortPolicyResults([
    { outcome: "complies" as const, title: "b" },
    { outcome: "not_applicable" as const, title: "a" },
    { outcome: "violates" as const, title: "z" },
    { outcome: "uncertain" as const, title: "y" },
    { outcome: "violates" as const, title: "c" },
  ]);
  assert.deepEqual(sorted.map((r) => r.title), ["c", "z", "y", "b", "a"]);
});
