// renderNotification for skill.hyped (SKILLY_SPEC.md §50.7): the shared subject, the §50.7 body
// sentence, the "See who's hyping it" link to the skill page, and the webhook fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNotification } from "./deliver.js";

const BASE = "https://skilly.test";

test("renderNotification: skill.hyped names the skill, its rank, the top N and the hype count", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({
    type: "skill.hyped",
    payload: { skillId: "s1", namespaceSlug: "team-a", skillSlug: "pdf", skillTitle: "PDF tools", rank: 2, score: 17, hypeCount: 6, topN: 5 },
  });
  assert.equal(r.subject, "Skilly - Your skill is being hyped");
  assert.equal(
    r.text,
    `"PDF tools" entered the top 5 hyped skills at #2, with 6 hypes in the last 7 days. [See who's hyping it](${BASE}/skills/team-a/pdf)`,
  );
  assert.equal((r.webhook as Record<string, unknown>).rank, 2);
  assert.equal((r.webhook as Record<string, unknown>).topN, 5);
  assert.doesNotMatch(r.text, /\{|\}/, "no JSON leaks into the body");
});

test("renderNotification: skill.hyped falls back to the slug and a singular count", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({ type: "skill.hyped", payload: { namespaceSlug: "team-a", skillSlug: "pdf", rank: 1, hypeCount: 1, topN: 3 } });
  assert.match(r.text, /^"team-a\/pdf" entered the top 3 hyped skills at #1, with 1 hype in the last 7 days\./);
});
