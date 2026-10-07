// Unit tests for "Draft with AI" (SKILLY_SPEC.md §43.12): the prompt's egress (SKILL.md redacted
// and capped, category names capped), output validation, category post-processing and the
// rolling daily-cap decision.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_DRAFT_BODY_MAX,
  AI_DRAFT_CATEGORIES_SENT_MAX,
  AI_DRAFT_DAILY_CAP,
  AI_DRAFT_DESCRIPTION_MAX,
  AI_DRAFT_USAGE_MAX,
  AI_DRAFT_WINDOW_MS,
  buildDraftPrompt,
  draftDailyCapDecision,
  processDraftCategories,
  sliceCodePointSafe,
  validateDraftOutput,
} from "./ai-draft.js";
import { isSecretLikeLine } from "./scan.js";
import { categorySlug } from "./category.js";

const known = ["ai ml", "pdf", "data analysis", "writing"].map((name) => ({ name, slug: categorySlug(name) }));

test("buildDraftPrompt sends only the SKILL.md and the category names", () => {
  const md = "---\nname: pdf-tool\ndescription: Use when the user asks about PDFs\n---\n# PDF\nSteps here.";
  const p = buildDraftPrompt({ skillMd: md, categories: ["writing", "pdf"], isSecretLine: isSecretLikeLine });
  assert.equal(p.truncated, false);
  assert.ok(p.user.includes("Steps here."));
  assert.ok(p.user.includes("- pdf\n- writing")); // sorted
  assert.ok(p.user.includes("<<<SKILL_MD"));
  assert.ok(!p.user.includes("Bundled files"));
  assert.match(p.system, /untrusted data/);
});

test("buildDraftPrompt redacts secret-scanner lines", () => {
  const md = "# Skill\naws_key = AKIAIOSFODNN7EXAMPLE\nkeep me";
  const p = buildDraftPrompt({ skillMd: md, categories: [], isSecretLine: isSecretLikeLine });
  assert.ok(p.user.includes("[redacted]"));
  assert.ok(!p.user.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(p.user.includes("keep me"));
  assert.ok(p.user.includes("- none yet"));
});

test("buildDraftPrompt truncates the SKILL.md at 60,000 characters with a note", () => {
  const md = "x".repeat(AI_DRAFT_BODY_MAX + 500);
  const p = buildDraftPrompt({ skillMd: md, categories: [], isSecretLine: () => false });
  assert.equal(p.truncated, true);
  assert.ok(p.user.includes(`truncated at ${AI_DRAFT_BODY_MAX}`));
  assert.ok(!p.user.includes("x".repeat(AI_DRAFT_BODY_MAX + 1)));
});

test("buildDraftPrompt caps the category list at 500", () => {
  const cats = Array.from({ length: 600 }, (_, i) => `cat ${String(i).padStart(3, "0")}`);
  const p = buildDraftPrompt({ skillMd: "# s", categories: cats, isSecretLine: () => false });
  assert.ok(p.user.includes(`(600, first ${AI_DRAFT_CATEGORIES_SENT_MAX} shown)`));
  assert.ok(p.user.includes("- cat 499"));
  assert.ok(!p.user.includes("- cat 500"));
});

test("sliceCodePointSafe never splits a surrogate pair", () => {
  assert.equal(sliceCodePointSafe("ab😀", 3), "ab");
  assert.equal(sliceCodePointSafe("ab😀", 4), "ab😀");
  assert.equal(sliceCodePointSafe("abc", 10), "abc");
});

test("processDraftCategories: case/trim, exact and slug matches map to existing", () => {
  const out = processDraftCategories(["  PDF ", "AI & ML", "Writing"], known);
  assert.deepEqual(out, [
    { name: "pdf", isNew: false },
    { name: "ai ml", isNew: false },
    { name: "writing", isNew: false },
  ]);
});

test("processDraftCategories: at most 2 new, 4 total, invalid/reserved/over-long dropped, de-duplicated", () => {
  const out = processDraftCategories(
    ["general", "&&&", "x".repeat(65), 42, "Automation", "automation", "devops", "security", "pdf", "writing"],
    known,
  );
  assert.deepEqual(out, [
    { name: "automation", isNew: true },
    { name: "devops", isNew: true },
    { name: "pdf", isNew: false },
    { name: "writing", isNew: false },
  ]);
  assert.equal(processDraftCategories([], known).length, 0);
});

test("validateDraftOutput: shape errors return null", () => {
  assert.equal(validateDraftOutput(null, known), null);
  assert.equal(validateDraftOutput([], known), null);
  assert.equal(validateDraftOutput({ description: "d", usage: "u" }, known), null);
  assert.equal(validateDraftOutput({ description: "", usage: "u", categories: [] }, known), null);
  assert.equal(validateDraftOutput({ description: "d", usage: "   ", categories: [] }, known), null);
  assert.equal(validateDraftOutput({ description: 1, usage: "u", categories: [] }, known), null);
  assert.equal(validateDraftOutput({ description: "d", usage: "u", categories: "pdf" }, known), null);
});

test("validateDraftOutput: trims to caps, folds description newlines, processes categories", () => {
  const out = validateDraftOutput(
    { description: `Line one\n  line two ${"d".repeat(400)}`, usage: `  ${"u".repeat(3000)}`, categories: ["PDF", "brand new"] },
    known,
  );
  assert.ok(out);
  assert.ok(out.description.startsWith("Line one line two "));
  assert.ok(out.description.length <= AI_DRAFT_DESCRIPTION_MAX);
  assert.equal(out.usage.length, AI_DRAFT_USAGE_MAX);
  assert.deepEqual(out.categories, [{ name: "pdf", isNew: false }, { name: "brand new", isNew: true }]);
});

test("validateDraftOutput: folds blank lines and CRLF; linear on long whitespace runs", () => {
  const out = validateDraftOutput({ description: "  one \r\n\n\n  two\t\n three  ", usage: "u", categories: [] }, known);
  assert.equal(out?.description, "one two three");
  const spaces = " ".repeat(200_000);
  const started = Date.now();
  const big = validateDraftOutput({ description: `a${spaces}\n${spaces}b`, usage: "u", categories: [] }, known);
  assert.ok(Date.now() - started < 500, "no polynomial backtracking");
  assert.equal(big?.description, "a b");
});

test("draftDailyCapDecision: rolling 24 h window, retryAt when the pivot call ages out", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  const under = Array.from({ length: AI_DRAFT_DAILY_CAP - 1 }, (_, i) => minsAgo(i + 1));
  assert.deepEqual(draftDailyCapDecision(under, now), { ok: true });

  const full = Array.from({ length: AI_DRAFT_DAILY_CAP }, (_, i) => minsAgo(i + 1)); // oldest = 50 min ago
  const d = draftDailyCapDecision(full, now);
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.retryAt.getTime(), minsAgo(AI_DRAFT_DAILY_CAP).getTime() + AI_DRAFT_WINDOW_MS);

  // Calls older than the window don't count.
  const aged = [...under, new Date(now.getTime() - AI_DRAFT_WINDOW_MS - 1)];
  assert.deepEqual(draftDailyCapDecision(aged, now), { ok: true });
});
