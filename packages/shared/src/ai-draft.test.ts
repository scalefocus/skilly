// Unit tests for "Draft with AI" (SKILLY_SPEC.md §43.12): the prompt's egress (SKILL.md redacted
// and capped, category names capped), output validation, category post-processing and the
// rolling daily-cap decision.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_DRAFT_BODY_MAX,
  AI_DRAFT_CATEGORIES_SENT_MAX,
  AI_DRAFT_DAILY_CAP,
  AI_DRAFT_DAILY_CAP_MAX,
  AI_DRAFT_DAILY_CAP_MIN,
  AI_DRAFT_DESCRIPTION_MAX,
  AI_DRAFT_USAGE_MAX,
  AI_DRAFT_WINDOW_MS,
  aiDraftLimitView,
  buildDraftPrompt,
  draftDailyCapDecision,
  effectiveAiDraftDailyCap,
  parseAiDraftDailyCapOverride,
  processDraftCategories,
  sliceCodePointSafe,
  validateAiDraftLimitInput,
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

// ---- the admin-adjustable daily cap (§40.17) -------------------------------------------------------------

test("draftDailyCapDecision with an admin cap: a lowered cap blocks, a raised cap lets the same history through", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  const ten = Array.from({ length: 10 }, (_, i) => minsAgo(i + 1)); // calls 1..10 minutes ago

  // Lowered to 3 with 10 calls already made: blocked until the 3rd-newest call ages out — only then
  // are fewer than 3 left in the window.
  const lowered = draftDailyCapDecision(ten, now, 3);
  assert.equal(lowered.ok, false);
  if (!lowered.ok) assert.equal(lowered.retryAt.getTime(), minsAgo(3).getTime() + AI_DRAFT_WINDOW_MS);

  // A full default window is let through the moment the cap is raised above it.
  const full = Array.from({ length: AI_DRAFT_DAILY_CAP }, (_, i) => minsAgo(i + 1));
  assert.equal(draftDailyCapDecision(full, now).ok, false);
  assert.deepEqual(draftDailyCapDecision(full, now, AI_DRAFT_DAILY_CAP + 1), { ok: true });

  // The smallest cap an admin can set still allows one draft.
  assert.deepEqual(draftDailyCapDecision([], now, AI_DRAFT_DAILY_CAP_MIN), { ok: true });
  assert.equal(draftDailyCapDecision([minsAgo(5)], now, AI_DRAFT_DAILY_CAP_MIN).ok, false);
});

test("parseAiDraftDailyCapOverride: a stored value is clamped into 1–1000, anything else is ignored", () => {
  assert.equal(parseAiDraftDailyCapOverride(200), 200);
  assert.equal(parseAiDraftDailyCapOverride(AI_DRAFT_DAILY_CAP_MIN), 1);
  assert.equal(parseAiDraftDailyCapOverride(AI_DRAFT_DAILY_CAP_MAX), 1000);
  // Out of range: clamped, so a hand-edited row can neither switch drafting off nor lift the cap.
  assert.equal(parseAiDraftDailyCapOverride(0), 1);
  assert.equal(parseAiDraftDailyCapOverride(-7), 1);
  assert.equal(parseAiDraftDailyCapOverride(50_000), 1000);
  // Not a whole number: the default applies.
  for (const junk of [undefined, null, "200", 12.5, Number.NaN, Number.POSITIVE_INFINITY, true, {}, [200]]) {
    assert.equal(parseAiDraftDailyCapOverride(junk), null, String(junk));
  }
});

test("effectiveAiDraftDailyCap / aiDraftLimitView: override → default", () => {
  assert.equal(effectiveAiDraftDailyCap(null), AI_DRAFT_DAILY_CAP);
  assert.equal(effectiveAiDraftDailyCap(120), 120);
  assert.deepEqual(aiDraftLimitView(null), { defaultCap: 50, overrideCap: null, effectiveCap: 50, min: 1, max: 1000 });
  assert.deepEqual(aiDraftLimitView(120), { defaultCap: 50, overrideCap: 120, effectiveCap: 120, min: 1, max: 1000 });
});

test("validateAiDraftLimitInput: whole numbers 1–1000, null clears, everything else is refused", () => {
  assert.deepEqual(validateAiDraftLimitInput({ dailyCap: 1 }), { ok: true, value: 1 });
  assert.deepEqual(validateAiDraftLimitInput({ dailyCap: 1000 }), { ok: true, value: 1000 });
  assert.deepEqual(validateAiDraftLimitInput({ dailyCap: 50 }), { ok: true, value: 50 });
  assert.deepEqual(validateAiDraftLimitInput({ dailyCap: null }), { ok: true, value: null });

  for (const bad of [{ dailyCap: 0 }, { dailyCap: 1001 }, { dailyCap: -1 }]) {
    const v = validateAiDraftLimitInput(bad);
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.error, /between 1 and 1000/);
  }
  for (const bad of [{ dailyCap: 12.5 }, { dailyCap: "50" }, { dailyCap: Number.NaN }, { dailyCap: true }]) {
    const v = validateAiDraftLimitInput(bad);
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.error, /whole number/);
  }
  // A missing key is not "restore the default" — that takes an explicit null.
  for (const bad of [{}, null, undefined, [], "50", 50]) {
    const v = validateAiDraftLimitInput(bad);
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.error, /dailyCap is required/);
  }
});
