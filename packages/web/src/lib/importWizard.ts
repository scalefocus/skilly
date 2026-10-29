// The repository import's wizard rules (SKILLY_SPEC.md §64.4): what each step holds, the checks
// Next runs before leaving a step (the propose form's submit-time rules), the step strip's states,
// which steps may be jumped to, and when Submit is enabled. Pure, so the unit test covers it.
import { isValidSemver } from "@skilly/shared/semver";
import { checkCategoryNames, type KnownCategory } from "@skilly/shared/category";
import { GENERIC_AGENT, isAgentSlug } from "@skilly/shared/agents";

export type StepDraft = "none" | "queued" | "drafting" | "done" | "failed" | "capped" | "skipped";

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
  /** The frontmatter values the Undo link restores (§64.4). */
  base: { description: string; usageExamples: string; categories: string[] };
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

/** Merge a successful AI draft into a step (§64.4): it replaces the frontmatter Description and
 *  Usage and adds its categories, capped like the propose form (12). */
export function applyDraft(step: WizardStep, draft: { description: string; usage: string; categories: string[] }): WizardStep {
  const have = new Set(step.categories.map((c) => c.toLowerCase()));
  const added: string[] = [];
  for (const c of draft.categories) {
    const v = c.trim().toLowerCase();
    if (!v || have.has(v) || step.categories.length + added.length >= 12) continue;
    have.add(v);
    added.push(v);
  }
  return {
    ...step,
    description: draft.description.trim() || step.description,
    usageExamples: draft.usage.trim() || step.usageExamples,
    categories: [...step.categories, ...added],
    draftedCategories: added,
    draft: "done",
    undoable: true,
  };
}

/** Undo (§64.4): back to the SKILL.md values; drafted categories still selected are removed. */
export function undoDraft(step: WizardStep): WizardStep {
  const drafted = new Set(step.draftedCategories);
  return {
    ...step,
    description: step.base.description,
    usageExamples: step.base.usageExamples,
    categories: step.categories.filter((c) => !drafted.has(c)),
    draftedCategories: [],
    undoable: false,
  };
}
