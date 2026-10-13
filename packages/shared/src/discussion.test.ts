import { test } from "node:test";
import assert from "node:assert/strict";
import { discussionDeleteAction, discussionFanOutPlan, replyRootId } from "./discussion.js";

test("replyRootId: a top-level parent is the root; a reply's parent normalises to its root (§24)", () => {
  assert.equal(replyRootId({ id: "root", parentId: null, removed: false }), "root");
  assert.equal(replyRootId({ id: "reply", parentId: "root", removed: false }), "root");
});

test("discussionFanOutPlan: mention > reply > discussion, author never notified (§12)", () => {
  const plan = discussionFanOutPlan("author", ["mentioned", "rootAuthor"], ["rootAuthor", "replier", "author", "replier"]);
  // The root author was mentioned too: the mention wins, so no reply row for them.
  assert.deepEqual(plan.replyCandidates, ["replier"]);
  // skill.discussion skips everyone this message already reaches more specifically.
  assert.deepEqual(plan.discussionExclude.sort(), ["mentioned", "replier", "rootAuthor"]);
});

test("discussionFanOutPlan: a top-level comment has no thread people", () => {
  const plan = discussionFanOutPlan("author", [], []);
  assert.deepEqual(plan, { replyCandidates: [], discussionExclude: [] });
});

test("discussionDeleteAction: reply / childless root / root with replies / last reply under a tombstone (§24)", () => {
  assert.deepEqual(discussionDeleteAction({ isReply: true, liveReplies: 3, parentRemoved: false }), { kind: "delete", sweepParent: false });
  assert.deepEqual(discussionDeleteAction({ isReply: false, liveReplies: 0, parentRemoved: false }), { kind: "delete", sweepParent: false });
  assert.deepEqual(discussionDeleteAction({ isReply: false, liveReplies: 2, parentRemoved: false }), { kind: "tombstone" });
  assert.deepEqual(discussionDeleteAction({ isReply: true, liveReplies: 1, parentRemoved: true }), { kind: "delete", sweepParent: true });
  // Not the last reply under the tombstone: the placeholder still holds someone's reply.
  assert.deepEqual(discussionDeleteAction({ isReply: true, liveReplies: 2, parentRemoved: true }), { kind: "delete", sweepParent: false });
});
