// Deleting a namespace (SKILLY_SPEC.md §72). Client-safe: the pure rules shared by the admin
// dialog, the web API and the worker's notification renderer. The DB orchestration lives in
// packages/web/src/lib/namespaceDelete.ts; the disk purge in packages/worker/src/git/namespacePurge.ts.

/** The longest reason an admin may give (§72.5). */
export const NAMESPACE_DELETE_REASON_MAX = 500;

/** Machine-readable codes on the §72.9 refusals. */
export const NAMESPACE_NOT_EMPTY_CODE = "namespace_not_empty";
export const GLOBAL_NAMESPACE_CODE = "global_namespace";
export const CONFIRM_MISMATCH_CODE = "confirm_mismatch";
export const REASON_TOO_LONG_CODE = "reason_too_long";

/** How many blockers of each kind the preflight lists (§72.5 / §72.9). */
export const NAMESPACE_DELETE_LIST_LIMIT = 50;

/**
 * Proposal states that block a delete when the proposal targets the namespace (§72.2). A move
 * proposal in `awaiting_destination` also blocks the namespace it waits for.
 */
export const OPEN_PROPOSAL_STATES = ["proposed", "under_review", "changes_requested", "awaiting_destination"] as const;

/** A reason as stored: trimmed, and empty means none. */
export function normalizeDeleteReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const t = reason.trim();
  return t ? t : null;
}

/**
 * Why a delete request can't proceed before the database is consulted (§72.9), or null. The typed
 * confirmation must equal the slug exactly; `global` is never deletable.
 */
export function deleteRequestError(input: { slug: string; confirmSlug: unknown; reason: unknown }): typeof GLOBAL_NAMESPACE_CODE | typeof CONFIRM_MISMATCH_CODE | typeof REASON_TOO_LONG_CODE | null {
  if (input.slug === "global") return GLOBAL_NAMESPACE_CODE;
  if (typeof input.confirmSlug !== "string" || input.confirmSlug !== input.slug) return CONFIRM_MISMATCH_CODE;
  const reason = normalizeDeleteReason(input.reason);
  if (reason && reason.length > NAMESPACE_DELETE_REASON_MAX) return REASON_TOO_LONG_CODE;
  return null;
}

/** Human messages for the §72.9 refusal codes. */
export const NAMESPACE_DELETE_MESSAGES: Record<string, string> = {
  [GLOBAL_NAMESPACE_CODE]: "the global namespace can't be deleted",
  [CONFIRM_MISMATCH_CODE]: "type the namespace's slug exactly to confirm",
  [REASON_TOO_LONG_CODE]: `the reason can be at most ${NAMESPACE_DELETE_REASON_MAX} characters`,
  [NAMESPACE_NOT_EMPTY_CODE]: "the namespace still holds live skills or open proposals",
};

/**
 * The destination a re-homed closed proposal keeps (§72.3 step 4). A move proposal's destination
 * must differ from its target (the §70.11 CHECK), so when re-homing makes them equal the
 * destination is dropped; the move itself stays in the audit log (`skill.moved`).
 */
export function rehomedDestination(destinationNamespaceId: string | null, newTargetNamespaceId: string): string | null {
  return destinationNamespaceId && destinationNamespaceId !== newTargetNamespaceId ? destinationNamespaceId : null;
}

/** What the delete did, or will do: the §72.7 counts (also the preflight's `effects`). */
export interface NamespaceDeleteEffects {
  archivedSkillsPurged: number;
  proposalsRehomed: number;
  proposalsDeleted: number;
  usageRowsRehomed: number;
  aliasesDropped: number;
  grantsRevoked: number;
  marketplaceEnabled: boolean;
  marketplaceTokensRevoked: number;
  policyRulesDeleted: number;
  roleMappingsRemoved: number;
  importsRemoved: number;
  adminsNotified: number;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The Ready state's consequence lines (§72.5), in order, omitting any whose count is 0. Analytics
 * and imports are bookkeeping and stay out of the dialog (they are in the audit record).
 */
export function namespaceDeleteEffectLines(e: NamespaceDeleteEffects): string[] {
  const lines: string[] = [];
  if (e.archivedSkillsPurged) lines.push(`${plural(e.archivedSkillsPurged, "archived skill", "archived skills")} will be permanently deleted`);
  if (e.proposalsRehomed) lines.push(`${plural(e.proposalsRehomed, "proposal", "proposals")} of skills that moved out will move to the skills' current namespaces`);
  if (e.proposalsDeleted) lines.push(`${plural(e.proposalsDeleted, "closed proposal", "closed proposals")} with no surviving skill will be deleted`);
  if (e.aliasesDropped) lines.push(`${plural(e.aliasesDropped, "old address", "old addresses")} of moved skills will stop working`);
  if (e.grantsRevoked) lines.push(`${plural(e.grantsRevoked, "shared skill", "shared skills")} will no longer be shared with it`);
  if (e.marketplaceEnabled) lines.push(`The marketplace will be turned off and ${plural(e.marketplaceTokensRevoked, "subscription", "subscriptions")} revoked`);
  if (e.policyRulesDeleted) lines.push(`${plural(e.policyRulesDeleted, "policy rule", "policy rules")} will be deleted`);
  if (e.roleMappingsRemoved) lines.push(`${plural(e.roleMappingsRemoved, "role mapping", "role mappings")} will be removed`);
  if (e.adminsNotified) lines.push(`${plural(e.adminsNotified, "namespace admin", "namespace admins")} will be notified`);
  return lines;
}

/**
 * The `namespace.deleted` notification sentence (§72.6), shared by the in-app center and the email
 * renderer. There is no CTA: the namespace has no page any more.
 */
export function namespaceDeletedSentence(payload: Record<string, unknown>): string {
  const actor = typeof payload.actorName === "string" && payload.actorName ? payload.actorName : "A platform admin";
  const slug = typeof payload.namespaceSlug === "string" ? payload.namespaceSlug : "";
  const name = typeof payload.displayName === "string" && payload.displayName ? payload.displayName : slug;
  const reason = typeof payload.reason === "string" && payload.reason.trim() ? ` Reason: ${payload.reason.trim()}` : "";
  return `${actor} deleted the namespace ${name} (@${slug}). Its role mappings, shares and marketplace were removed.${reason}`;
}
