// renderNotification for the two search-gap types (SKILLY_SPEC.md §62.9): the shared subject,
// sentence and call-to-action link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNotification } from "./deliver.js";

const BASE = "https://skilly.test";

test("renderNotification: search_gaps.ready points platform admins at the review page", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({ type: "search_gaps.ready", payload: { count: 3 } });
  assert.equal(r.subject, "Skilly - Search gaps to review");
  assert.equal(r.text, `3 search gaps are waiting for review. [Review search gaps](${BASE}/admin/search-gaps)`);
});

test("renderNotification: skill.search_gap_hidden_match names the search and the skill", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({
    type: "skill.search_gap_hidden_match",
    payload: { query: "merge pdfs", namespaceSlug: "fin", skillSlug: "pdf-tools", searchers: 4, days: 30 },
  });
  assert.equal(r.subject, "Skilly - Search for a restricted skill");
  assert.match(r.text, /^People searched for "merge pdfs" and couldn't find fin\/pdf-tools, because only its namespace can see it\. Up to 4 people in the last 30 days\./);
  assert.match(r.text, /\[View the skill\]\(https:\/\/skilly\.test\/skills\/fin\/pdf-tools\)$/);
});
