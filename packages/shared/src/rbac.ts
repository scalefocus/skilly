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

/**
 * Is a skill visible to this user? org-wide skills are visible to all authenticated
 * users; namespace-scoped skills only to members of that namespace (any role) and
 * platform admins. INVARIANT: enforce this on EVERY search/list/fetch path.
 */
export function isSkillVisible(a: EffectiveAccess, skill: Pick<Skill, "namespaceId" | "visibility">): boolean {
  if (skill.visibility === "org") return true;
  if (a.isPlatformAdmin) return true;
  return a.namespaceRoles.has(skill.namespaceId);
}

/** Namespace ids the user can see scoped (namespace-visibility) skills in. */
export function visibleNamespaceIds(a: EffectiveAccess): string[] {
  return [...a.namespaceRoles.keys()];
}

export type { Visibility };
