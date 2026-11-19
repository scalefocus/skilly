// Moving a skill to another namespace through a new-version proposal (SKILLY_SPEC.md §70).
// Client-safe: pure rules shared by the propose form, the proposal page, the web API and the
// worker. The DB orchestration lives in packages/web/src/lib/proposals.ts + skillAliases.ts.
import { canDirectPublish, canReviewNamespace, type EffectiveAccess } from "./rbac.js";
import type { ProposalState } from "./types.js";

/** The state a move proposal waits in between the owner's and the destination's accept (§70.3). */
export const AWAITING_DESTINATION: ProposalState = "awaiting_destination";

/** Machine-readable codes on the §70 refusals (409 / 422 bodies). */
export const SLUG_EXISTS_IN_DESTINATION_CODE = "slug_exists_in_destination";
export const SKILL_MOVED_CODE = "skill_moved";
export const SLUG_RESERVED_CODE = "slug_reserved";
export const INVALID_DESTINATION_CODE = "invalid_destination";

/**
 * The destination a submission really asks for: null when absent, blank, or equal to the skill's
 * current owner — picking the owner again cancels the move (§70.2).
 */
export function effectiveDestination(destinationId: string | null | undefined, ownerNamespaceId: string): string | null {
  const d = typeof destinationId === "string" ? destinationId.trim() : "";
  return d && d !== ownerNamespaceId ? d : null;
}

/** Why a destination namespace can't be used (§70.1/§70.2), or null when it can. */
export function destinationError(dest: { slug: string } | null): string | null {
  if (!dest) return "the destination namespace doesn't exist";
  if (dest.slug === "global") return "a skill can't be moved into the global namespace — promote it to global instead";
  return null;
}

/** The fields of a proposal the move rules read. */
export interface MoveProposalRef {
  state: ProposalState;
  /** The skill's owner when the proposal was filed (or re-routed) — the owner stage's reviewers. */
  targetNamespaceId: string;
  /** Set ⇒ the current revision moves the skill there. */
  destinationNamespaceId: string | null;
}

/** The namespace whose reviewers act on the proposal right now (§70.3). */
export function actingReviewNamespaceId(p: MoveProposalRef): string {
  return p.state === AWAITING_DESTINATION && p.destinationNamespaceId ? p.destinationNamespaceId : p.targetNamespaceId;
}

/** May this viewer accept / request changes / reject at the proposal's current stage? */
export function canActOnProposal(access: EffectiveAccess, p: MoveProposalRef): boolean {
  return canReviewNamespace(access, actingReviewNamespaceId(p));
}

/**
 * May this viewer read the proposal as a reviewer (§70.3)? The owner's reviewers always may. The
 * destination's reviewers may only once the owner has approved — the owner's accept is its consent
 * to show the bytes — that is, in `awaiting_destination`, and after the move is accepted.
 */
export function canViewProposalAsReviewer(access: EffectiveAccess, p: MoveProposalRef): boolean {
  if (canReviewNamespace(access, p.targetNamespaceId)) return true;
  if (!p.destinationNamespaceId) return false;
  if (p.state !== AWAITING_DESTINATION && p.state !== "accepted") return false;
  return canReviewNamespace(access, p.destinationNamespaceId);
}

/** A namespace as the direct-publish rule reads it. */
export interface PublishNamespace {
  id: string;
  requireReview: boolean;
}

/**
 * §70.5: a direct publish that moves the skill publishes and moves at once only when the publisher
 * could direct-publish into EACH namespace on its own (platform admin, an admin there, or a member
 * there with `require_review = false`).
 */
export function canDirectPublishMove(access: EffectiveAccess, owner: PublishNamespace, destination: PublishNamespace): boolean {
  return canDirectPublish(access, owner.id, owner.requireReview) && canDirectPublish(access, destination.id, destination.requireReview);
}

/**
 * §70.2: the shared-namespaces list once a destination is picked — the current owner is added (so
 * its members keep access unless someone removes it) and the destination is dropped (an owner is
 * never its own grantee). Order-stable, de-duplicated.
 */
export function withMoveGrants(shared: readonly string[], ownerNamespaceId: string, destinationNamespaceId: string): string[] {
  const out: string[] = [];
  for (const id of [...shared, ownerNamespaceId]) {
    if (id === destinationNamespaceId || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** The `skill_moved` refusal (§70.7 step 1). */
export function skillMovedMessage(currentNamespaceSlug: string, skillSlug: string, sourceNamespaceSlug: string | null): string {
  const from = sourceNamespaceSlug ? `${sourceNamespaceSlug}/${skillSlug}` : skillSlug;
  return `${from} moved to ${currentNamespaceSlug}/${skillSlug} since this proposal was written — request changes so the proposer can resubmit`;
}

/** The generic reserved-slug refusal (§70.6) — names no skill. */
export function slugReservedMessage(namespaceSlug: string, skillSlug: string): string {
  return `${skillSlug} isn't available in ${namespaceSlug} — choose another slug`;
}

/** The destination-conflict refusal (§70.2/§70.3). `visibleName` only when the reader can see it. */
export function slugInDestinationMessage(destinationSlug: string, skillSlug: string, visible: { name: string } | null, alias = false): string {
  if (alias) return `${skillSlug} is reserved in ${destinationSlug} by a skill that moved out of it — the skill can't move there`;
  if (visible) return `${destinationSlug} already has a skill named ${skillSlug} (${visible.name}) — choose another destination`;
  return `${skillSlug} isn't available in ${destinationSlug}`;
}

// ── §74: moving a NEW-SKILL proposal to another namespace (a hand-off, not a two-stage move) ─────

/** Machine-readable codes on the §74 refusals (409 / 422 bodies). */
export const NOT_A_NEW_SKILL_PROPOSAL_CODE = "not_a_new_skill_proposal";
export const INVALID_TARGET_NAMESPACE_CODE = "invalid_target_namespace";
export const PROPOSAL_DECIDED_CODE = "proposal_decided";

/** The states a new-skill proposal may be moved in (§74.2). */
export const RETARGETABLE_STATES: readonly ProposalState[] = ["proposed", "under_review", "changes_requested"];

/** A namespace as the move-target rule reads it. */
export interface RetargetNamespace {
  id: string;
  slug: string;
}

/**
 * §74.2: the namespaces a reviewer may move a new-skill proposal to, in the order given.
 *  1. Base set — a platform admin: every namespace; anyone else: `global` plus every namespace in
 *     which they hold a role (the propose form's list).
 *  2. While the contribution policy is *members only* (`proposalsOpen` false), only namespaces the
 *     PROPOSER may propose into (any for a platform-admin proposer, else the ones they hold a role
 *     in). An unknown proposer (`null`) qualifies for none.
 *  3. Minus the proposal's current namespace.
 */
export function moveTargetIds(input: {
  reviewer: EffectiveAccess;
  proposer: EffectiveAccess | null;
  proposalsOpen: boolean;
  namespaces: readonly RetargetNamespace[];
  currentNamespaceId: string;
}): string[] {
  const { reviewer, proposer } = input;
  return input.namespaces
    .filter((n) => n.id !== input.currentNamespaceId)
    .filter((n) => reviewer.isPlatformAdmin || n.slug === "global" || reviewer.namespaceRoles.has(n.id))
    .filter((n) => input.proposalsOpen || (proposer !== null && (proposer.isPlatformAdmin || proposer.namespaceRoles.has(n.id))))
    .map((n) => n.id);
}

/**
 * §74.3 step 3: the state after a move. Nobody in the new namespace has started a review, so a
 * reviewer-turn proposal goes back to `proposed`; `changes_requested` stays (the proposer's turn).
 */
export function retargetedState(state: ProposalState): ProposalState {
  return state === "changes_requested" ? "changes_requested" : "proposed";
}

/**
 * §74.4: the shared-namespaces list of a restricted proposal moved from `fromId` to `toId` — the
 * new owner leaves the list (an owner is never its own grantee) and the old namespace joins it, so
 * the audience the proposer asked for keeps access. Order-stable, de-duplicated.
 */
export function withRetargetGrants(shared: readonly string[], fromId: string, toId: string): string[] {
  return withMoveGrants(shared, fromId, toId);
}

/** §74.3 step 2: the move revision's note — "Moved from @A to @B", then the reviewer's own note. */
export function retargetNote(fromSlug: string, toSlug: string, note?: string | null): string {
  const base = `Moved from @${fromSlug} to @${toSlug}`;
  const extra = (note ?? "").trim();
  return extra ? `${base}: ${extra}` : base;
}

/** §74.5: the slug-conflict refusal at the new namespace. `visibleName` only when the reader can see it. */
export function slugInTargetMessage(targetSlug: string, skillSlug: string, visible: { name: string } | null, alias = false): string {
  if (alias && visible) return `${skillSlug} is reserved in ${targetSlug} by a skill that moved out of it (${visible.name})`;
  if (visible) return `${targetSlug} already has a skill named ${skillSlug} (${visible.name})`;
  return `${skillSlug} isn't available in ${targetSlug}`;
}
