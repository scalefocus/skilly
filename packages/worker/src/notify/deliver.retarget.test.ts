// renderNotification for §74.8: a reviewer moved a new-skill proposal to another namespace, and the
// accept of a Move & accept says where the skill was published.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNotification, notificationBodySentence } from "./deliver.js";

const BASE = "https://skilly.test";

test("renderNotification: proposal.retargeted names the mover, both namespaces and who reviews next", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({
    type: "proposal.retargeted",
    payload: { proposalId: "p1", skillSlug: "pdf", fromNamespaceSlug: "team-a", namespaceSlug: "team-b", state: "proposed", byName: "Ada Admin", note: null },
  });
  assert.equal(r.subject, "Skilly - Proposal moved");
  assert.equal(r.text, "Ada Admin moved your proposal for pdf from team-a to team-b. team-b's reviewers will review it. [View the proposal](https://skilly.test/proposals/p1)");
  assert.equal(r.webhook.from, "team-a");
  assert.equal(r.webhook.to, "team-b");
});

test("renderNotification: proposal.retargeted in changes_requested keeps the proposer's turn, and carries the note", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({
    type: "proposal.retargeted",
    payload: { proposalId: "p1", skillSlug: "pdf", fromNamespaceSlug: "team-a", namespaceSlug: "team-b", state: "changes_requested", byName: "Ada Admin", note: "B owns PDFs" },
  });
  assert.match(r.text, /It still needs your changes\. When you resubmit, team-b's reviewers will review it\. Reviewer note: "B owns PDFs" \[View the proposal\]/);
  assert.doesNotMatch(notificationBodySentence({ type: "proposal.retargeted", payload: { proposalId: "p1", skillSlug: "pdf", fromNamespaceSlug: "team-a", namespaceSlug: "team-b" } }), /[[{}]/);
});

test("renderNotification: proposal.accept after a Move & accept says where it was published", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const moved = renderNotification({ type: "proposal.accept", payload: { proposalId: "p1", state: "accepted", note: null, movedToNamespaceSlug: "team-b" } });
  assert.equal(moved.text, "Your skill proposal was accepted. It was moved to team-b and published there. [View it](https://skilly.test/proposals/p1)");
  const plain = renderNotification({ type: "proposal.accept", payload: { proposalId: "p1", state: "accepted", note: null } });
  assert.equal(plain.text, "Your skill proposal was accepted. [View it](https://skilly.test/proposals/p1)");
});
