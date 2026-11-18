// renderNotification for the two §70.9 notifications: a skill moved to another namespace, and the
// owner's approval of a move proposal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNotification, notificationBodySentence } from "./deliver.js";

const BASE = "https://skilly.test";

test("renderNotification: skill.moved names both addresses, the version, and links to the new one", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({
    type: "skill.moved",
    payload: { skillId: "s1", skillSlug: "pdf", skillTitle: "PDF", namespaceSlug: "team-b", oldNamespaceSlug: "team-a", semver: "1.3.0", marketplaceName: null },
  });
  assert.equal(r.subject, "Skilly - Skill moved");
  assert.equal(
    r.text,
    "team-a/pdf moved to team-b/pdf and published version 1.3.0. Existing installs keep working; new installs use the new address. [View the skill](https://skilly.test/skills/team-b/pdf)",
  );
  assert.equal(r.webhook.skill, "team-b/pdf");
  assert.equal(r.webhook.previousSkill, "team-a/pdf");
  assert.doesNotMatch(r.text, /[{}]|marketplace/);
});

test("renderNotification: skill.moved adds the marketplace sentence when the skill is listed", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({
    type: "skill.moved",
    payload: { skillId: "s1", skillSlug: "pdf", namespaceSlug: "team-b", oldNamespaceSlug: "team-a", semver: "1.3.0", marketplaceName: "team-b-pdf" },
  });
  assert.match(r.text, /new installs use the new address\. In plugin marketplaces it is now listed as team-b-pdf\. \[View the skill\]/);
  // The digest's bare sentence drops the CTA (§48.9).
  assert.doesNotMatch(notificationBodySentence({ type: "skill.moved", payload: { skillSlug: "pdf", namespaceSlug: "team-b", oldNamespaceSlug: "team-a", semver: "1.3.0" } }), /\[/);
});

test("renderNotification: proposal.owner_accepted says who approved and who decides next", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({
    type: "proposal.owner_accepted",
    payload: { proposalId: "p1", skillSlug: "pdf", semver: "1.3.0", namespaceSlug: "team-a", destinationSlug: "team-b" },
  });
  assert.equal(r.subject, "Skilly - Proposal approved by the owner");
  assert.equal(r.text, "team-a approved your proposal for team-a/pdf. It now waits for team-b. [View the proposal](https://skilly.test/proposals/p1)");
  assert.equal(r.webhook.destination, "team-b");
});
