// renderNotification for the five idea.* types (SKILLY_SPEC.md §60.7): the shared subject, the
// shared sentence (with the reason / note on its own paragraph) and the call-to-action link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNotification } from "./deliver.js";

const BASE = "https://skilly.test";

test("renderNotification: idea.submitted points platform admins at the review page", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({ type: "idea.submitted", payload: { count: 2 } });
  assert.equal(r.subject, "Skilly - Feature idea submitted");
  assert.equal(r.text, `2 new feature ideas are waiting for review. [Review ideas](${BASE}/admin/ideas)`);
});

test("renderNotification: idea.rejected carries the reason and the excerpt", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({ type: "idea.rejected", payload: { ideaId: "i1", reason: "Already possible.", excerpt: "Let me export CSV" } });
  assert.equal(r.subject, "Skilly - Feature idea not published");
  assert.equal(
    r.text,
    `Your feature idea wasn't published. Reason: Already possible.\n\n"Let me export CSV" [Your ideas](${BASE}/whats-new#your-ideas)`,
  );
  assert.equal((r.webhook as Record<string, unknown>).ideaId, "i1");
});

test("renderNotification: idea.closed and idea.shipped name the idea", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const closed = renderNotification({ type: "idea.closed", payload: { title: "CSV export", outcome: "duplicate", adminNote: "See the other one." } });
  assert.match(closed.text, /^Your feature idea "CSV export" was closed: Duplicate\.\n\nSee the other one\. \[Your ideas\]/);
  const shipped = renderNotification({ type: "idea.shipped", payload: { title: "CSV export" } });
  assert.equal(shipped.subject, "Skilly - Feature idea shipped");
  assert.equal(shipped.text, `A feature you suggested has shipped: "CSV export" is now part of skilly. [What's new](${BASE}/whats-new)`);
  const published = renderNotification({ type: "idea.published", payload: { title: "CSV export" } });
  assert.match(published.text, /\(https:\/\/skilly\.test\/whats-new#coming-soon\)$/);
});
