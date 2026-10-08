// renderNotification for the two §47.10 policy notifications: the subjects, the cited rules and the
// links to the Policy sections.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNotification } from "./deliver.js";

const BASE = "https://skilly.test";

test("renderNotification: proposal.policy_violation cites each rule with its explanation and links to #policy", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({
    type: "proposal.policy_violation",
    payload: {
      proposalId: "p-1",
      namespaceSlug: "team-a",
      skillSlug: "fetcher",
      semver: "1.0.0",
      rules: [{ title: "No external APIs", explanation: "scripts/run.sh calls curl directly." }],
    },
  });
  assert.equal(r.subject, "Skilly - Policy check flagged your proposal");
  assert.match(r.text, /^The policy check flagged your proposal for team-a\/fetcher: No external APIs\./);
  assert.match(r.text, /- No external APIs — scripts\/run\.sh calls curl directly\./);
  assert.match(r.text, /\[See the policy check\]\(https:\/\/skilly\.test\/proposals\/p-1#policy\)/);
  assert.deepEqual((r.webhook as { rules: string[] }).rules, ["No external APIs"]);
});

test("renderNotification: skill.policy_flag names the version and the violated rules", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({
    type: "skill.policy_flag",
    payload: { namespaceSlug: "team-a", skillSlug: "fetcher", semver: "1.2.0", rules: ["No external APIs", "English only"] },
  });
  assert.equal(r.subject, "Skilly - Policy check flagged a skill");
  assert.equal(
    r.text,
    "team-a/fetcher v1.2.0 violates: No external APIs, English only. [Review the policy check](https://skilly.test/skills/team-a/fetcher#policy)",
  );
});
