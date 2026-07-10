import { test } from "node:test";
import assert from "node:assert/strict";
import { nextState, canPerform, isTerminal } from "./proposal.js";

const reviewer = { isReviewer: true, isSubmitter: false };
const submitter = { isReviewer: false, isSubmitter: true };
const bystander = { isReviewer: false, isSubmitter: false };

test("legal transitions", () => {
  assert.equal(nextState("start_review", "proposed"), "under_review");
  assert.equal(nextState("request_changes", "under_review"), "changes_requested");
  assert.equal(nextState("resubmit", "changes_requested"), "under_review");
  assert.equal(nextState("accept", "under_review"), "accepted");
  assert.equal(nextState("reject", "proposed"), "rejected");
  assert.equal(nextState("start_review", "changes_requested"), "under_review");
});

test("illegal transitions return null", () => {
  assert.equal(nextState("accept", "proposed"), null); // must be under_review first
  assert.equal(nextState("resubmit", "under_review"), null);
  assert.equal(nextState("request_changes", "accepted"), null);
});

test("terminal states", () => {
  assert.ok(isTerminal("accepted"));
  assert.ok(isTerminal("rejected"));
  assert.ok(!isTerminal("under_review"));
});

test("reviewer-only actions require reviewer", () => {
  assert.deepEqual(canPerform("accept", "under_review", reviewer), { ok: true, to: "accepted" });
  assert.equal(canPerform("accept", "under_review", submitter).ok, false);
  assert.equal(canPerform("reject", "under_review", bystander).ok, false);
});

test("only submitter may resubmit", () => {
  assert.deepEqual(canPerform("resubmit", "changes_requested", submitter), { ok: true, to: "under_review" });
  assert.equal(canPerform("resubmit", "changes_requested", reviewer).ok, false);
});

test("no action from terminal", () => {
  assert.equal(canPerform("reject", "accepted", reviewer).ok, false);
  assert.equal(canPerform("start_review", "rejected", reviewer).ok, false);
});
