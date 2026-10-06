// renderNotification for skill.quality_low (SKILLY_SPEC.md §41.9): the subject, the score line,
// every finding with its hint, the AI summary and recommendations, and the Quality-card link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNotification } from "./deliver.js";

const BASE = "https://skilly.test";

test("renderNotification: skill.quality_low carries the score, every finding, the AI recommendations and the card link", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({
    type: "skill.quality_low",
    payload: {
      namespaceSlug: "team-a",
      skillSlug: "pdf",
      semver: "1.2.0",
      score: 32,
      stars: 2,
      mode: "rules+ai",
      findings: [
        { rule: "DS-001", level: "warn", path: "SKILL.md", line: 3, message: "the description never says when to use the skill" },
        { rule: "FS-003", level: "error", path: "README.md", line: null, message: "README inside the skill folder" },
      ],
      summary: "The instructions are vague and the steps are out of order.",
      suggestions: ["State when to use the skill.", "Number the steps."],
    },
  });
  assert.equal(r.subject, "Skilly - Low quality score");
  assert.match(r.text, /team-a\/pdf v1\.2\.0 scored 2 ★ \(32\/100, rules \+ AI assessment\)\./);
  // Errors first, then warnings; each with its path and the guide's hint.
  const fs = r.text.indexOf("FS-003");
  const ds = r.text.indexOf("DS-001");
  assert.ok(fs > 0 && ds > fs, "errors listed before warnings");
  assert.match(r.text, /FS-003 \[error\] README\.md — README inside the skill folder\. All documentation goes in SKILL\.md/);
  assert.match(r.text, /DS-001 \[warn\] SKILL\.md:3 — the description never says when to use the skill\./);
  assert.match(r.text, /AI assessment: The instructions are vague/);
  assert.match(r.text, /Recommendations:\n1\. State when to use the skill\.\n2\. Number the steps\./);
  assert.match(r.text, /\[Open the Quality card\]\(https:\/\/skilly\.test\/skills\/team-a\/pdf#quality\)/);
  assert.equal(r.webhook.event, "skill.quality_low");
  assert.equal(r.webhook.score, 32);
  assert.doesNotMatch(r.text, /[{}]/); // never a JSON dump
});

test("renderNotification: skill.quality_low without AI or findings still reads as a sentence", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({
    type: "skill.quality_low",
    payload: { namespaceSlug: "team-a", skillSlug: "pdf", semver: "0.1.0", score: 8, stars: 0.5, mode: "rules", findings: [], suggestions: [] },
  });
  assert.match(r.text, /scored 0\.5 ★ \(8\/100, rules only\)\./);
  assert.match(r.text, /No rule findings\./);
  assert.doesNotMatch(r.text, /AI assessment:/);
  assert.doesNotMatch(r.text, /Recommendations:/);
});
