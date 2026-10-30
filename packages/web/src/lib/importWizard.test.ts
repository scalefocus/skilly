// Unit tests for the repository import's wizard gating (SKILLY_SPEC.md §64.4, §64.12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDraft, canJumpTo, canSubmit, stepErrors, stepState, typedFields, undoDraft, type WizardStep } from "./importWizard";

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
  draftKey: null,
  draftClicked: false,
  draftMessage: null,
  filled: { description: "Reads PDFs.", usageExamples: "" },
  beforeDraft: null,
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

const draftA = { description: "Draft A.", usage: "Usage A.", categories: [] };
const draftB = { description: "Draft B.", usage: "Usage B.", categories: ["search"] };

test("typedFields: no confirm over the SKILL.md pre-fill or a draft's text, a confirm once typed into", () => {
  assert.deepEqual(typedFields(step()), [], "the pre-fill");
  const drafted = applyDraft(step(), draftA);
  assert.deepEqual(typedFields(drafted), [], "a draft's text");
  assert.deepEqual(typedFields({ ...drafted, description: "Mine." }), ["Description"]);
  assert.deepEqual(typedFields({ ...drafted, description: "Mine.", usageExamples: "My usage." }), ["Description", "Usage"]);
  assert.deepEqual(typedFields(step({ usageExamples: "Typed." })), ["Usage"]);
});

test("applyDraft with fill 'empty' keeps a non-empty field, and typed text still counts as typed", () => {
  const typed = step({ description: "Mine." });
  const drafted = applyDraft(typed, draftB, "empty");
  assert.equal(drafted.description, "Mine.", "a non-empty field is left alone");
  assert.equal(drafted.usageExamples, "Usage B.", "the empty Usage is filled");
  assert.deepEqual(drafted.categories, ["documents", "search"], "categories are added either way");
  assert.deepEqual(typedFields(drafted), ["Description"]);
  const replaced = applyDraft(typed, draftB, "replace");
  assert.equal(replaced.description, "Draft B.");
  assert.deepEqual(typedFields(replaced), []);
});

test("undoDraft after a second draft restores the first draft's text, and restored typed text still asks", () => {
  const second = applyDraft(applyDraft(step(), draftA), draftB);
  const undone = undoDraft(second);
  assert.equal(undone.description, "Draft A.");
  assert.equal(undone.usageExamples, "Usage A.");
  assert.deepEqual(undone.categories, ["documents"], "the second draft's category is removed");
  assert.deepEqual(typedFields(undone), []);
  assert.equal(undoDraft(undone), undone, "single-step: nothing more to undo");

  const typedThenDrafted = applyDraft(step({ description: "Mine." }), draftB, "replace");
  const back = undoDraft(typedThenDrafted);
  assert.equal(back.description, "Mine.");
  assert.deepEqual(typedFields(back), ["Description"], "the restored text was typed, so the next draft asks");
});
