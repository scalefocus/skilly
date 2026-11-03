// renderNotification for review assignments and targets (SKILLY_SPEC.md §65.8): the four new types
// render the shared wording with a link, and a folded reminder links to the filtered queue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationBodySentence, renderNotification } from "./deliver.js";

const BASE = "https://skilly.test";

test("renderNotification: proposal.assigned, one proposal and a whole import", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const one = renderNotification({ type: "proposal.assigned", payload: { proposalId: "p1", ns: "team-a", slug: "pdf", byName: "Ana" } });
  assert.equal(one.subject, "Skilly - Proposal assigned to you");
  assert.equal(one.text, `Ana assigned you the proposal for team-a/pdf. [Review it](${BASE}/proposals/p1)`);
  const imp = renderNotification({ type: "proposal.assigned", payload: { importId: "i1", ns: "team-a", repo: "acme/skills", count: 2, byName: "Ana" } });
  assert.equal(imp.text, `Ana assigned you 2 proposals imported from acme/skills into team-a. [Review them](${BASE}/proposals?tab=review&import=i1&assignee=me)`);
});

test("renderNotification: the reminders, single and folded", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const single = renderNotification({ type: "proposal.review_overdue", payload: { nsId: "n1", ns: "team-a", days: 2, count: 1, proposalIds: ["p1"], slug: "pdf" } });
  assert.equal(single.subject, "Skilly - Review overdue");
  assert.equal(single.text, `The proposal for team-a/pdf is past team-a's review target of 2 business days. [Review it](${BASE}/proposals/p1)`);
  const folded = renderNotification({ type: "proposal.review_escalated", payload: { nsId: "n1", ns: "team-a", days: 2, count: 3, proposalIds: ["p1", "p2", "p3"], slug: "pdf" } });
  assert.equal(folded.text, `3 proposals in team-a have waited twice the review target of 2 business days. [Review them](${BASE}/proposals?tab=review&ns=team-a&overdue=1)`);
  assert.deepEqual(folded.webhook.proposalIds, ["p1", "p2", "p3"]);
  assert.equal(
    notificationBodySentence({ type: "proposal.changes_reminder", payload: { nsId: "n1", ns: "team-a", days: 2, count: 1, proposalIds: ["p9"], slug: "pdf" } }),
    "Your proposal for team-a/pdf is still waiting on the changes the reviewer asked for.",
  );
});
