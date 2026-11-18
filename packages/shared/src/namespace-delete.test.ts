// SKILLY_SPEC.md §72 — the pure rules of deleting a namespace.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deleteRequestError,
  namespaceDeleteEffectLines,
  namespaceDeletedSentence,
  normalizeDeleteReason,
  rehomedDestination,
  NAMESPACE_DELETE_REASON_MAX,
  OPEN_PROPOSAL_STATES,
  type NamespaceDeleteEffects,
} from "./namespace-delete.js";

const NONE: NamespaceDeleteEffects = {
  archivedSkillsPurged: 0,
  proposalsRehomed: 0,
  proposalsDeleted: 0,
  usageRowsRehomed: 0,
  aliasesDropped: 0,
  grantsRevoked: 0,
  marketplaceEnabled: false,
  marketplaceTokensRevoked: 0,
  policyRulesDeleted: 0,
  roleMappingsRemoved: 0,
  importsRemoved: 0,
  adminsNotified: 0,
};

test("the open states that block a delete are exactly the four undecided ones (§72.2)", () => {
  assert.deepEqual([...OPEN_PROPOSAL_STATES].sort(), ["awaiting_destination", "changes_requested", "proposed", "under_review"]);
  assert.ok(!(OPEN_PROPOSAL_STATES as readonly string[]).includes("accepted"));
  assert.ok(!(OPEN_PROPOSAL_STATES as readonly string[]).includes("rejected"));
});

test("deleteRequestError: global is never deletable, whatever is typed", () => {
  assert.equal(deleteRequestError({ slug: "global", confirmSlug: "global", reason: null }), "global_namespace");
});

test("deleteRequestError: the typed slug must match exactly", () => {
  assert.equal(deleteRequestError({ slug: "team-a", confirmSlug: "team-a", reason: undefined }), null);
  assert.equal(deleteRequestError({ slug: "team-a", confirmSlug: "Team-A", reason: undefined }), "confirm_mismatch");
  assert.equal(deleteRequestError({ slug: "team-a", confirmSlug: "team-a ", reason: undefined }), "confirm_mismatch");
  assert.equal(deleteRequestError({ slug: "team-a", confirmSlug: "", reason: undefined }), "confirm_mismatch");
  assert.equal(deleteRequestError({ slug: "team-a", confirmSlug: undefined, reason: undefined }), "confirm_mismatch");
  assert.equal(deleteRequestError({ slug: "team-a", confirmSlug: 1, reason: undefined }), "confirm_mismatch");
});

test("deleteRequestError: the reason is optional and capped at 500 characters", () => {
  assert.equal(deleteRequestError({ slug: "team-a", confirmSlug: "team-a", reason: "x".repeat(NAMESPACE_DELETE_REASON_MAX) }), null);
  assert.equal(deleteRequestError({ slug: "team-a", confirmSlug: "team-a", reason: "x".repeat(NAMESPACE_DELETE_REASON_MAX + 1) }), "reason_too_long");
  // Surrounding whitespace doesn't count against the limit.
  assert.equal(deleteRequestError({ slug: "team-a", confirmSlug: "team-a", reason: `  ${"x".repeat(NAMESPACE_DELETE_REASON_MAX)}  ` }), null);
});

test("normalizeDeleteReason: trimmed, and blank or non-text means none", () => {
  assert.equal(normalizeDeleteReason("  merged into team-b  "), "merged into team-b");
  assert.equal(normalizeDeleteReason("   "), null);
  assert.equal(normalizeDeleteReason(undefined), null);
  assert.equal(normalizeDeleteReason(42), null);
});

test("rehomedDestination: a move proposal keeps its destination unless it would equal the new target", () => {
  assert.equal(rehomedDestination(null, "B"), null);
  assert.equal(rehomedDestination("C", "B"), "C");
  // A → B move re-homed to B: target and destination may not be equal (the §70.11 CHECK).
  assert.equal(rehomedDestination("B", "B"), null);
});

test("namespaceDeleteEffectLines: nothing to say for an empty namespace", () => {
  assert.deepEqual(namespaceDeleteEffectLines(NONE), []);
});

test("namespaceDeleteEffectLines: omits zero counts, pluralizes, and keeps bookkeeping out", () => {
  const lines = namespaceDeleteEffectLines({
    ...NONE,
    archivedSkillsPurged: 1,
    proposalsRehomed: 3,
    aliasesDropped: 2,
    marketplaceEnabled: true,
    marketplaceTokensRevoked: 1,
    roleMappingsRemoved: 2,
    adminsNotified: 1,
    usageRowsRehomed: 40,
    importsRemoved: 1,
  });
  assert.deepEqual(lines, [
    "1 archived skill will be permanently deleted",
    "3 proposals of skills that moved out will move to the skills' current namespaces",
    "2 old addresses of moved skills will stop working",
    "The marketplace will be turned off and 1 subscription revoked",
    "2 role mappings will be removed",
    "1 namespace admin will be notified",
  ]);
});

test("namespaceDeleteEffectLines: an enabled marketplace is mentioned even with no subscriptions", () => {
  assert.deepEqual(namespaceDeleteEffectLines({ ...NONE, marketplaceEnabled: true }), ["The marketplace will be turned off and 0 subscriptions revoked"]);
});

test("namespaceDeletedSentence: names the actor and the namespace, and adds the reason when given", () => {
  assert.equal(
    namespaceDeletedSentence({ actorName: "Pat Admin", namespaceSlug: "team-a", displayName: "Team A" }),
    "Pat Admin deleted the namespace Team A (@team-a). Its role mappings, shares and marketplace were removed.",
  );
  assert.equal(
    namespaceDeletedSentence({ actorName: "Pat Admin", namespaceSlug: "team-a", displayName: "Team A", reason: " Merged into team-b. " }),
    "Pat Admin deleted the namespace Team A (@team-a). Its role mappings, shares and marketplace were removed. Reason: Merged into team-b.",
  );
});

test("namespaceDeletedSentence: falls back when the actor or display name is missing", () => {
  assert.equal(
    namespaceDeletedSentence({ namespaceSlug: "team-a", reason: null }),
    "A platform admin deleted the namespace team-a (@team-a). Its role mappings, shares and marketplace were removed.",
  );
});
