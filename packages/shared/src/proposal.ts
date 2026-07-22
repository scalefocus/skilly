// Proposal/review state machine — pure, testable governance core. SKILLY_SPEC.md §8.
//
//   proposed ──► under_review ──► changes_requested ⇄ under_review ──► accepted
//                     │                                              └► rejected
//                     └────────────────────────────────────────────────► rejected
//
// `revise` (§8) is the one non-transitioning action: in `proposed`/`under_review` the proposer
// may update the proposal in place (new revision, same state).
//
// Terminal states: accepted, rejected. Acceptance materializes a SkillVersion (done by
// the caller; this module only governs legality + who may act).
import type { ProposalState } from "./types.js";

export type ProposalAction = "start_review" | "request_changes" | "resubmit" | "revise" | "accept" | "reject";

/** Which kind of actor may perform an action. */
export type ActorKind = "reviewer" | "proposer";

interface Rule {
  from: ProposalState[];
  /** Target state; "same" = an in-place action that never transitions (§8 `revise`). */
  to: ProposalState | "same";
  actor: ActorKind;
}

export const TRANSITIONS: Record<ProposalAction, Rule> = {
  start_review: { from: ["proposed", "changes_requested"], to: "under_review", actor: "reviewer" },
  request_changes: { from: ["under_review"], to: "changes_requested", actor: "reviewer" },
  resubmit: { from: ["changes_requested"], to: "under_review", actor: "proposer" },
  // Proposer mid-review edit (§8): a new revision in place — no state change, review continues.
  revise: { from: ["proposed", "under_review"], to: "same", actor: "proposer" },
  accept: { from: ["under_review"], to: "accepted", actor: "reviewer" },
  reject: { from: ["proposed", "under_review", "changes_requested"], to: "rejected", actor: "reviewer" },
};

export const TERMINAL_STATES: ProposalState[] = ["accepted", "rejected"];

/**
 * Max length of a per-version "What changed" note (§8) — plain text, client-counted and
 * server-enforced. Kept here (governance core) so the propose form and the API share one bound.
 */
export const WHAT_CHANGED_MAX_LEN = 4000;

export function isTerminal(state: ProposalState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** The next state for an action from a given state, or null if the transition is illegal. */
export function nextState(action: ProposalAction, from: ProposalState): ProposalState | null {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(from)) return null;
  return rule.to === "same" ? from : rule.to;
}

export interface ActorCaps {
  /** caller is a reviewer for the proposal's target namespace (namespace admin / platform admin) */
  isReviewer: boolean;
  /** caller is the proposal's original submitter */
  isSubmitter: boolean;
}

export type PerformResult =
  | { ok: true; to: ProposalState }
  | { ok: false; reason: string };

/**
 * Validate that `action` is legal from `from` AND that the caller is permitted to perform
 * it. Acceptance/rejection require a reviewer; resubmission requires the submitter.
 */
export function canPerform(action: ProposalAction, from: ProposalState, caps: ActorCaps): PerformResult {
  if (isTerminal(from)) return { ok: false, reason: `proposal is in terminal state '${from}'` };

  const rule = TRANSITIONS[action];
  const to = nextState(action, from);
  if (!to) return { ok: false, reason: `cannot '${action}' from '${from}'` };

  if (rule.actor === "reviewer" && !caps.isReviewer) {
    return { ok: false, reason: "reviewer role required" };
  }
  if (rule.actor === "proposer" && !caps.isSubmitter) {
    return { ok: false, reason: `only the proposer may ${action}` };
  }
  return { ok: true, to };
}
