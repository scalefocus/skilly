// The repository import's wizard rules (SKILLY_SPEC.md §64.4): what each step holds, the checks
// Next runs before leaving a step (the propose form's submit-time rules), the step strip's states,
// which steps may be jumped to, when Submit is enabled, and how an AI draft lands and is undone
// (including when a step's own Draft button must confirm first). Pure, so the unit test covers it.
import { isValidSemver } from "@skilly/shared/semver";
import { checkCategoryNames, type KnownCategory } from "@skilly/shared/category";
import { GENERIC_AGENT, isAgentSlug } from "@skilly/shared/agents";

export type StepDraft = "none" | "queued" | "drafting" | "done" | "failed" | "capped" | "skipped";

export type TextFields = { description: string; usageExamples: string };

export interface WizardStep {
  /** The SKILL.md path — the step's identity. */
  path: string;
  subdir: string | null;
  skillSlug: string;
  title: string;
  description: string;
  usageExamples: string;
  categories: string[];
  toolHarness: string;
  semver: string;
  iconEmoji: string;
  iconSha256: string | null;
  /** Opened at least once (the first time through, steps open in order). */
  opened: boolean;
  draft: StepDraft;
  /** The draft queue key of the step's live draft request; a reply for any other key is ignored. */
  draftKey: string | null;
  /** The live (or last) draft came from the step's own button, not the pick-page option. */
  draftClicked: boolean;
  /** Why the step's own last draft failed (the server's §43.6 message). */
  draftMessage: string | null;
  /** The text the SKILL.md pre-fill or a draft last put in Description and Usage: anything else
   *  there was typed by the proposer, so the step's Draft button confirms first (§64.4). */
  filled: TextFields;
  /** What Undo restores: the text, and what counted as typed, from just before the latest draft. */
  beforeDraft: (TextFields & { filled: TextFields }) | null;
  /** Categories the AI draft added that Undo removes. */
  draftedCategories: string[];
  /** Undo is offered until the proposer edits Description or Usage. */
  undoable: boolean;
  /** The server's reason when this skill failed at submit (*Fix and resubmit*). */
  submitError: string | null;
}

/** The checks Next runs (§64.4): the same rules the propose form applies on submit. */
export function stepErrors(step: WizardStep, knownCategories: readonly KnownCategory[] = []): string[] {
  const errs: string[] = [];
  if (!step.title.trim()) errs.push("Give the skill a title.");
  if (!step.description.trim()) errs.push("Give the skill a description.");
  if (!isValidSemver(step.semver.trim())) errs.push("Use a semver version, such as 1.0.0.");
  const catErr = checkCategoryNames(step.categories, knownCategories);
  if (catErr) errs.push(catErr);
  if (step.toolHarness !== GENERIC_AGENT && !isAgentSlug(step.toolHarness)) errs.push("Choose a tool/harness from the list.");
  return errs;
}

export function isDrafting(step: WizardStep): boolean {
  return step.draft === "queued" || step.draft === "drafting";
}

/** The step strip (§64.4): done = opened and passing; the current step is current. */
export function stepState(steps: readonly WizardStep[], index: number, current: number, knownCategories: readonly KnownCategory[] = []): "done" | "current" | "not_opened" | "needs_attention" {
  if (index === current) return "current";
  const s = steps[index]!;
  if (!s.opened) return "not_opened";
  return stepErrors(s, knownCategories).length || s.submitError ? "needs_attention" : "done";
}

/** Any step already opened can be jumped to; the first time through they open in order. */
export function canJumpTo(steps: readonly WizardStep[], index: number): boolean {
  return !!steps[index]?.opened;
}

/** Submit is enabled only when every remaining step has been opened and passes (§64.1 decision 9). */
export function canSubmit(steps: readonly WizardStep[], knownCategories: readonly KnownCategory[] = []): boolean {
  return steps.length > 0 && steps.every((s) => s.opened && !isDrafting(s) && stepErrors(s, knownCategories).length === 0);
}

/** Typed text (§64.4): not empty, and not what the pre-fill or a draft last put there. */
const isTyped = (value: string, filled: string) => !!value.trim() && value !== filled;

/** The fields holding typed text. A step's Draft button confirms before replacing them. */
export function typedFields(step: WizardStep): ("Description" | "Usage")[] {
  const out: ("Description" | "Usage")[] = [];
  if (isTyped(step.description, step.filled.description)) out.push("Description");
  if (isTyped(step.usageExamples, step.filled.usageExamples)) out.push("Usage");
  return out;
}

/** Merge a successful AI draft into a step (§64.4): it replaces Description and Usage (all but
 *  the typed ones with `fill: "keep"`) and adds its categories, capped like the propose form (12). */
export function applyDraft(step: WizardStep, draft: { description: string; usage: string; categories: string[] }, fill: "replace" | "keep" = "replace"): WizardStep {
  const have = new Set(step.categories.map((c) => c.toLowerCase()));
  const added: string[] = [];
  for (const c of draft.categories) {
    const v = c.trim().toLowerCase();
    if (!v || have.has(v) || step.categories.length + added.length >= 12) continue;
    have.add(v);
    added.push(v);
  }
  const description = (fill === "replace" || !isTyped(step.description, step.filled.description)) && draft.description.trim();
  const usageExamples = (fill === "replace" || !isTyped(step.usageExamples, step.filled.usageExamples)) && draft.usage.trim();
  return {
    ...step,
    description: description || step.description,
    usageExamples: usageExamples || step.usageExamples,
    categories: [...step.categories, ...added],
    filled: {
      description: description || step.filled.description,
      usageExamples: usageExamples || step.filled.usageExamples,
    },
    beforeDraft: { description: step.description, usageExamples: step.usageExamples, filled: step.filled },
    draftedCategories: added,
    draft: "done",
    draftKey: null,
    draftMessage: null,
    undoable: true,
  };
}

/** Undo (§64.4): back to the text from just before the latest draft (the SKILL.md values, for the
 *  first one), typed or not as it was then; drafted categories still selected are removed. */
export function undoDraft(step: WizardStep): WizardStep {
  if (!step.beforeDraft) return step;
  const drafted = new Set(step.draftedCategories);
  return {
    ...step,
    description: step.beforeDraft.description,
    usageExamples: step.beforeDraft.usageExamples,
    filled: step.beforeDraft.filled,
    beforeDraft: null,
    categories: step.categories.filter((c) => !drafted.has(c)),
    draftedCategories: [],
    undoable: false,
  };
}
