// RBAC resolution. INVARIANT: roles come from SCIM-synced group membership +
// role_mappings, NEVER from OIDC token claims (Entra ~200-group claim overage).
// See SKILLY_SPEC.md §4, §5 and CLAUDE.md invariant #1.

import type { Role, RoleMapping, Skill, Visibility } from "./types.js";

export interface EffectiveAccess {
  isPlatformAdmin: boolean;
  /** namespaceId -> highest role the user holds in that namespace */
  namespaceRoles: Map<string, Role>;
}

/**
 * Resolve a user's effective access from the set of Entra groups they belong to
 * (by group id) and the platform's role_mappings.
 */
export function resolveAccess(
  userGroupIds: ReadonlySet<string>,
  mappings: readonly RoleMapping[],
): EffectiveAccess {
  let isPlatformAdmin = false;
  const namespaceRoles = new Map<string, Role>();

  for (const m of mappings) {
    if (!userGroupIds.has(m.groupId)) continue;
    if (m.role === "platform_admin") {
      isPlatformAdmin = true;
      continue;
    }
    if (m.namespaceId == null) continue;
    const current = namespaceRoles.get(m.namespaceId);
    namespaceRoles.set(m.namespaceId, higherRole(current, m.role));
  }

  return { isPlatformAdmin, namespaceRoles };
}

function rank(role: Role | undefined): number {
  switch (role) {
    case "namespace_admin":
      return 2;
    case "namespace_member":
      return 1;
    default:
      return 0;
  }
}
function higherRole(a: Role | undefined, b: Role): Role {
  return rank(a) >= rank(b) ? (a as Role) : b;
}

// --- Capability checks (SKILLY_SPEC.md §4 permission matrix) ---

export function canReviewNamespace(a: EffectiveAccess, namespaceId: string): boolean {
  return a.isPlatformAdmin || a.namespaceRoles.get(namespaceId) === "namespace_admin";
}

export function canDirectPublish(
  a: EffectiveAccess,
  namespaceId: string,
  namespaceRequiresReview: boolean,
): boolean {
  if (a.isPlatformAdmin) return true;
  const role = a.namespaceRoles.get(namespaceId);
  if (role === "namespace_admin") return true;
  if (role === "namespace_member") return !namespaceRequiresReview;
  return false;
}

export function canInitiatePromotion(a: EffectiveAccess, owningNamespaceId: string): boolean {
  if (a.isPlatformAdmin) return true;
  const role = a.namespaceRoles.get(owningNamespaceId);
  return role === "namespace_admin" || role === "namespace_member";
}

export function canApprovePromotionToGlobal(a: EffectiveAccess): boolean {
  return a.isPlatformAdmin; // global namespace approval is platform-admin only
}

export function canYankOrArchive(a: EffectiveAccess, namespaceId: string): boolean {
  return a.isPlatformAdmin || a.namespaceRoles.get(namespaceId) === "namespace_admin";
}

/** Edit a namespace's settings — `require_review`, `maintainer_contact`, and the Claude plugin
 *  marketplace toggle — from the Namespace administration page or Administration (§30.6). */
export function canManageNamespaceSettings(a: EffectiveAccess, namespaceId: string): boolean {
  return a.isPlatformAdmin || a.namespaceRoles.get(namespaceId) === "namespace_admin";
}

/** May this user mint a token for a namespace's plugin marketplace? A namespace marketplace
 *  carries restricted skills, so it takes the same access the skills themselves take — ANY role
 *  in the namespace, not just admin. The PUBLIC marketplace needs no such check (§30.4). */
export function canUseNamespaceMarketplace(a: EffectiveAccess, namespaceId: string): boolean {
  return a.isPlatformAdmin || a.namespaceRoles.has(namespaceId);
}

/** The skill fields the visibility decision reads. `sharedNamespaceIds` = the skill's
 *  `skill_namespace_grants` (§42) — callers that load a restricted skill MUST supply it; omitting
 *  it is only correct for an `org` skill or a skill known to have no grants. */
export type VisibilitySubject = Pick<Skill, "namespaceId" | "visibility"> & {
  sharedNamespaceIds?: readonly string[] | null;
};

/**
 * Is a skill visible to this user? org-wide skills are visible to all authenticated
 * users; namespace-scoped skills only to members (any role) of the OWNING namespace or of a
 * namespace the skill is shared with (§42), and platform admins.
 * INVARIANT: enforce this on EVERY search/list/fetch path.
 */
export function isSkillVisible(a: EffectiveAccess, skill: VisibilitySubject): boolean {
  if (skill.visibility === "org") return true;
  if (a.isPlatformAdmin) return true;
  if (a.namespaceRoles.has(skill.namespaceId)) return true;
  return (skill.sharedNamespaceIds ?? []).some((id) => a.namespaceRoles.has(id));
}

/**
 * Does this viewer see the skill ONLY through a §42 grant? Drives the presentational
 * "Shared with your namespace by <owner>" marker: false for org skills, platform admins, and
 * members of the owning namespace.
 */
export function seesViaGrantOnly(a: EffectiveAccess, skill: VisibilitySubject): boolean {
  if (skill.visibility === "org" || a.isPlatformAdmin) return false;
  if (a.namespaceRoles.has(skill.namespaceId)) return false;
  return (skill.sharedNamespaceIds ?? []).some((id) => a.namespaceRoles.has(id));
}

// --- Namespace sharing authority (SKILLY_SPEC.md §42.2) ---

/** Add a grantee namespace: platform admin, an admin of the OWNING namespace, or an explicit
 *  maintainer of the skill (the caller resolves `isExplicitMaintainer` from skill_maintainers). */
export function canShareSkill(a: EffectiveAccess, owningNamespaceId: string, isExplicitMaintainer: boolean): boolean {
  if (a.isPlatformAdmin) return true;
  if (a.namespaceRoles.get(owningNamespaceId) === "namespace_admin") return true;
  return isExplicitMaintainer;
}

/** Revoke a grantee namespace: everyone who may share, plus an admin of the RECEIVING namespace
 *  (who may only revoke the share into their own namespace). */
export function canUnshareSkill(
  a: EffectiveAccess,
  owningNamespaceId: string,
  granteeNamespaceId: string,
  isExplicitMaintainer: boolean,
): boolean {
  if (canShareSkill(a, owningNamespaceId, isExplicitMaintainer)) return true;
  return a.namespaceRoles.get(granteeNamespaceId) === "namespace_admin";
}

/** Namespace ids the user can see scoped (namespace-visibility) skills in. */
export function visibleNamespaceIds(a: EffectiveAccess): string[] {
  return [...a.namespaceRoles.keys()];
}

export type { Visibility };
