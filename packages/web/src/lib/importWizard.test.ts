// Unit tests for the repository import's wizard gating (SKILLY_SPEC.md §64.4, §64.12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDraft, canJumpTo, canSubmit, stepErrors, stepState, undoDraft, type WizardStep } from "./importWizard";

const step = (over: Partial<WizardStep> = {}): WizardStep => ({
  path: "skills/pdf/SKILL.md",
  subdir: "skills/pdf",
  skillSlug: "pdf",
  title: "Pdf",
  description: "Reads PDFs.",
  usageExamples: "",
  categories: ["documents"],
  toolHarness: "generic",
  semver: "1.0.0",
  iconEmoji: "",
  iconSha256: null,
  opened: true,
  draft: "none",
  base: { description: "Reads PDFs.", usageExamples: "", categories: ["documents"] },
  draftedCategories: [],
  undoable: false,
  submitError: null,
  ...over,
});

test("stepErrors: title, description, semver, category and tool/harness rules", () => {
  assert.deepEqual(stepErrors(step()), []);
  assert.equal(stepErrors(step({ title: " " })).length, 1);
  assert.equal(stepErrors(step({ description: "" })).length, 1);
  assert.equal(stepErrors(step({ semver: "1.0" })).length, 1);
  assert.equal(stepErrors(step({ categories: ["general"] })).length, 1, "a reserved category");
  assert.equal(stepErrors(step({ categories: ["Docs"] }), [{ name: "docs", slug: "docs" }]).length, 0);
  assert.equal(stepErrors(step({ toolHarness: "made-up-agent" })).length, 1);
});

test("canSubmit: every remaining step opened, passing and not drafting", () => {
  assert.equal(canSubmit([]), false);
  assert.equal(canSubmit([step(), step({ path: "b" })]), true);
  assert.equal(canSubmit([step(), step({ path: "b", opened: false })]), false, "a step not yet opened");
  assert.equal(canSubmit([step(), step({ path: "b", title: "" })]), false, "a failing step");
  assert.equal(canSubmit([step(), step({ path: "b", draft: "drafting" })]), false, "a step still drafting");
});

test("stepState and canJumpTo: the strip, and jumps only to steps already opened", () => {
  const steps = [step(), step({ path: "b", title: "" }), step({ path: "c", opened: false })];
  assert.equal(stepState(steps, 0, 0), "current");
  assert.equal(stepState(steps, 0, 2), "done");
  assert.equal(stepState(steps, 1, 0), "needs_attention");
  assert.equal(stepState(steps, 2, 0), "not_opened");
  assert.equal(stepState([step({ submitError: "slug taken" })], 0, 1), "needs_attention");
  assert.ok(canJumpTo(steps, 1));
  assert.ok(!canJumpTo(steps, 2));
});

test("applyDraft replaces Description and Usage and adds categories; undoDraft restores the SKILL.md values", () => {
  const drafted = applyDraft(step(), { description: "Summarizes and searches PDFs.", usage: "Ask it to summarize.", categories: ["Documents", "search", " "] });
  assert.equal(drafted.description, "Summarizes and searches PDFs.");
  assert.equal(drafted.usageExamples, "Ask it to summarize.");
  assert.deepEqual(drafted.categories, ["documents", "search"]);
  assert.deepEqual(drafted.draftedCategories, ["search"]);
  assert.equal(drafted.draft, "done");
  assert.ok(drafted.undoable);
  const undone = undoDraft(drafted);
  assert.equal(undone.description, "Reads PDFs.");
  assert.equal(undone.usageExamples, "");
  assert.deepEqual(undone.categories, ["documents"]);
  assert.equal(undone.undoable, false);
  const full = applyDraft(step({ categories: Array.from({ length: 12 }, (_, i) => `c${i}`) }), { description: "d", usage: "u", categories: ["extra"] });
  assert.equal(full.categories.length, 12, "the field cap of 12 holds");
});
