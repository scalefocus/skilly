import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actingReviewNamespaceId,
  canActOnProposal,
  canDirectPublishMove,
  canViewProposalAsReviewer,
  destinationError,
  effectiveDestination,
  skillMovedMessage,
  slugInDestinationMessage,
  slugReservedMessage,
  withMoveGrants,
  moveTargetIds,
  retargetedState,
  withRetargetGrants,
  retargetNote,
  slugInTargetMessage,
  RETARGETABLE_STATES,
} from "./namespace-move.js";
import type { EffectiveAccess } from "./rbac.js";
import type { Role } from "./types.js";

const A = "11111111-1111-4111-8111-111111111111"; // the owner
const B = "22222222-2222-4222-8222-222222222222"; // the destination
const C = "33333333-3333-4333-8333-333333333333"; // an unrelated grantee

const access = (roles: Record<string, Role> = {}, isPlatformAdmin = false): EffectiveAccess => ({
  isPlatformAdmin,
  namespaceRoles: new Map(Object.entries(roles)),
});

test("effectiveDestination: absent, blank or the owner itself is no move (§70.2)", () => {
  assert.equal(effectiveDestination(undefined, A), null);
  assert.equal(effectiveDestination(null, A), null);
  assert.equal(effectiveDestination("  ", A), null);
  assert.equal(effectiveDestination(A, A), null);
  assert.equal(effectiveDestination(` ${B} `, A), B);
});

test("destinationError: unknown and global are refused (§70.1)", () => {
  assert.match(destinationError(null)!, /doesn't exist/);
  assert.match(destinationError({ slug: "global" })!, /global/);
  assert.equal(destinationError({ slug: "team-b" }), null);
});

test("the acting reviewers are the owner's until the owner accepts (§70.3)", () => {
  const p = { targetNamespaceId: A, destinationNamespaceId: B };
  assert.equal(actingReviewNamespaceId({ ...p, state: "under_review" }), A);
  assert.equal(actingReviewNamespaceId({ ...p, state: "awaiting_destination" }), B);
  // No destination: always the owner.
  assert.equal(actingReviewNamespaceId({ state: "awaiting_destination", targetNamespaceId: A, destinationNamespaceId: null }), A);

  const ownerAdmin = access({ [A]: "namespace_admin" });
  const destAdmin = access({ [B]: "namespace_admin" });
  assert.ok(canActOnProposal(ownerAdmin, { ...p, state: "under_review" }));
  assert.ok(!canActOnProposal(destAdmin, { ...p, state: "under_review" }));
  assert.ok(canActOnProposal(destAdmin, { ...p, state: "awaiting_destination" }));
  assert.ok(!canActOnProposal(ownerAdmin, { ...p, state: "awaiting_destination" }));
  assert.ok(canActOnProposal(access({}, true), { ...p, state: "awaiting_destination" }));
});

test("destination reviewers read the proposal only from the owner accept on (§70.3)", () => {
  const p = { targetNamespaceId: A, destinationNamespaceId: B };
  const destAdmin = access({ [B]: "namespace_admin" });
  for (const state of ["proposed", "under_review", "changes_requested", "rejected"] as const) {
    assert.ok(!canViewProposalAsReviewer(destAdmin, { ...p, state }), state);
  }
  assert.ok(canViewProposalAsReviewer(destAdmin, { ...p, state: "awaiting_destination" }));
  assert.ok(canViewProposalAsReviewer(destAdmin, { ...p, state: "accepted" }));
  // The owner's reviewers keep reading it throughout.
  assert.ok(canViewProposalAsReviewer(access({ [A]: "namespace_admin" }), { ...p, state: "awaiting_destination" }));
  // A destination MEMBER is not a reviewer.
  assert.ok(!canViewProposalAsReviewer(access({ [B]: "namespace_member" }), { ...p, state: "awaiting_destination" }));
});

test("canDirectPublishMove: allowed only when the publisher could publish into both (§70.5)", () => {
  const owner = { id: A, requireReview: false };
  const dest = { id: B, requireReview: false };
  assert.ok(canDirectPublishMove(access({ [A]: "namespace_member", [B]: "namespace_member" }), owner, dest));
  assert.ok(!canDirectPublishMove(access({ [A]: "namespace_member" }), owner, dest));
  assert.ok(!canDirectPublishMove(access({ [A]: "namespace_member", [B]: "namespace_member" }), owner, { id: B, requireReview: true }));
  assert.ok(canDirectPublishMove(access({ [A]: "namespace_admin", [B]: "namespace_admin" }), { id: A, requireReview: true }, { id: B, requireReview: true }));
  assert.ok(canDirectPublishMove(access({}, true), { id: A, requireReview: true }, { id: B, requireReview: true }));
});

test("withMoveGrants adds the old owner and drops the destination (§70.2)", () => {
  assert.deepEqual(withMoveGrants([], A, B), [A]);
  assert.deepEqual(withMoveGrants([C], A, B), [C, A]);
  assert.deepEqual(withMoveGrants([B, C], A, B), [C, A]);
  assert.deepEqual(withMoveGrants([A, C], A, B), [A, C]);
});

test("refusal messages name only what the reader may see", () => {
  assert.match(skillMovedMessage("team-b", "foo", "team-a"), /team-a\/foo moved to team-b\/foo/);
  assert.equal(slugReservedMessage("team-a", "foo"), "foo isn't available in team-a — choose another slug");
  assert.equal(slugInDestinationMessage("team-b", "foo", null), "foo isn't available in team-b");
  assert.match(slugInDestinationMessage("team-b", "foo", { name: "team-b/foo" }), /already has a skill named foo/);
  assert.match(slugInDestinationMessage("team-b", "foo", null, true), /reserved in team-b/);
});

// ── §74: moving a new-skill proposal ─────────────────────────────────────────

const G = "44444444-4444-4444-8444-444444444444"; // global
const NAMESPACES = [
  { id: G, slug: "global" },
  { id: A, slug: "team-a" },
  { id: B, slug: "team-b" },
  { id: C, slug: "team-c" },
];

test("moveTargetIds: a namespace admin gets global plus their own namespaces, minus the current one (§74.2)", () => {
  const reviewer = access({ [A]: "namespace_admin", [C]: "namespace_member" });
  assert.deepEqual(moveTargetIds({ reviewer, proposer: access(), proposalsOpen: true, namespaces: NAMESPACES, currentNamespaceId: A }), [G, C]);
});

test("moveTargetIds: a platform admin gets every namespace but the current one", () => {
  const reviewer = access({}, true);
  assert.deepEqual(moveTargetIds({ reviewer, proposer: access(), proposalsOpen: true, namespaces: NAMESPACES, currentNamespaceId: B }), [G, A, C]);
});

test("moveTargetIds: members only keeps the namespaces the PROPOSER could propose into, for every reviewer", () => {
  const proposer = access({ [B]: "namespace_member" });
  assert.deepEqual(moveTargetIds({ reviewer: access({}, true), proposer, proposalsOpen: false, namespaces: NAMESPACES, currentNamespaceId: A }), [B]);
  assert.deepEqual(moveTargetIds({ reviewer: access({ [A]: "namespace_admin", [C]: "namespace_member" }), proposer, proposalsOpen: false, namespaces: NAMESPACES, currentNamespaceId: A }), []);
  // global needs a role in it too while members-only is on.
  assert.deepEqual(moveTargetIds({ reviewer: access({}, true), proposer: access(), proposalsOpen: false, namespaces: NAMESPACES, currentNamespaceId: A }), []);
});

test("moveTargetIds: a platform-admin proposer qualifies everywhere; an unknown proposer nowhere", () => {
  const reviewer = access({}, true);
  assert.deepEqual(moveTargetIds({ reviewer, proposer: access({}, true), proposalsOpen: false, namespaces: NAMESPACES, currentNamespaceId: A }), [G, B, C]);
  assert.deepEqual(moveTargetIds({ reviewer, proposer: null, proposalsOpen: false, namespaces: NAMESPACES, currentNamespaceId: A }), []);
  assert.deepEqual(moveTargetIds({ reviewer, proposer: null, proposalsOpen: true, namespaces: NAMESPACES, currentNamespaceId: A }), [G, B, C]);
});

test("retargetedState: reviewer-turn states land in proposed; changes_requested stays (§74.3)", () => {
  assert.deepEqual([...RETARGETABLE_STATES], ["proposed", "under_review", "changes_requested"]);
  assert.equal(retargetedState("proposed"), "proposed");
  assert.equal(retargetedState("under_review"), "proposed");
  assert.equal(retargetedState("changes_requested"), "changes_requested");
});

test("withRetargetGrants: the new owner leaves the list and the old namespace joins it (§74.4)", () => {
  assert.deepEqual(withRetargetGrants([], A, B), [A]);
  assert.deepEqual(withRetargetGrants([B, C], A, B), [C, A]);
  assert.deepEqual(withRetargetGrants([A, C], A, B), [A, C]);
});

test("retargetNote: the move, then the reviewer's own note when given", () => {
  assert.equal(retargetNote("team-a", "team-b"), "Moved from @team-a to @team-b");
  assert.equal(retargetNote("team-a", "team-b", "  "), "Moved from @team-a to @team-b");
  assert.equal(retargetNote("team-a", "team-b", "belongs to B"), "Moved from @team-a to @team-b: belongs to B");
});

test("slugInTargetMessage: names the skill only when the reader can see it (invariant #3)", () => {
  assert.equal(slugInTargetMessage("team-b", "pdf", null), "pdf isn't available in team-b");
  assert.equal(slugInTargetMessage("team-b", "pdf", null, true), "pdf isn't available in team-b");
  assert.match(slugInTargetMessage("team-b", "pdf", { name: "team-b/pdf" }), /already has a skill named pdf \(team-b\/pdf\)/);
  assert.match(slugInTargetMessage("team-b", "pdf", { name: "team-c/pdf" }, true), /reserved in team-b by a skill that moved out of it/);
});
