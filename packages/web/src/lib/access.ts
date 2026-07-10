// DB-backed access resolution. Phase 1 (SKILLY_SPEC.md §4, §5).
// INVARIANT: roles come from SCIM-synced group_memberships + role_mappings, never
// from OIDC token claims. The bootstrap admin group grants platform_admin even before
// any role_mappings exist (first-admin chicken-and-egg, §5).
import { pool } from "./db";
import { resolveAccess, type EffectiveAccess, type RoleMapping } from "@skilly/shared";
import { createTtlCache } from "./ttlCache";

// Role mappings are org-wide and change only on SCIM reconcile / admin edit — caching them
// removes a full-table `role_mappings ⋈ groups` read from EVERY authenticated request. The
// per-user resolved access is cached very briefly to coalesce a single page's burst of
// parallel API calls (/me, /skills, /facets, /nav-badges, /notifications, …) without holding
// stale authorization: user-status / group-membership changes still take effect within seconds.
const ROLE_TTL_MS = Number(process.env.RBAC_ROLE_CACHE_TTL_MS ?? 30_000);
const ACCESS_TTL_MS = Number(process.env.RBAC_ACCESS_CACHE_TTL_MS ?? 5_000);
const roleMappingsCache = createTtlCache<{ mappings: RoleMapping[]; groupOidById: Map<string, string> }>(ROLE_TTL_MS);
const accessCache = createTtlCache<EffectiveAccess & { userId: string | null }>(ACCESS_TTL_MS);

/** Bust the RBAC caches immediately (call after a role-mapping / membership mutation). */
export function invalidateAccessCaches(): void {
  roleMappingsCache.clear();
  accessCache.clear();
}

/** Look up the internal user + their Entra group ids by Entra object id (oid from OIDC). */
async function loadUserGroupIds(entraOid: string): Promise<{ userId: string | null; groupEntraIds: Set<string> }> {
  const { rows } = await pool.query<{ user_id: string; group_oid: string | null }>(
    `select u.id as user_id, g.entra_object_id as group_oid
       from users u
       left join group_memberships gm on gm.user_id = u.id
       left join groups g on g.id = gm.group_id
      where u.entra_object_id = $1 and u.status = 'active'`,
    [entraOid],
  );
  const userId = rows[0]?.user_id ?? null;
  const groupEntraIds = new Set<string>();
  for (const r of rows) if (r.group_oid) groupEntraIds.add(r.group_oid);
  return { userId, groupEntraIds };
}

/** Load all role mappings, keyed by the Entra group object id (what we match against). */
async function loadRoleMappings(): Promise<{ mappings: RoleMapping[]; groupOidById: Map<string, string> }> {
  const { rows } = await pool.query<{
    id: string;
    namespace_id: string | null;
    role: RoleMapping["role"];
    group_id: string;
    group_oid: string;
  }>(
    `select rm.id, rm.namespace_id, rm.role, rm.group_id, g.entra_object_id as group_oid
       from role_mappings rm
       join groups g on g.id = rm.group_id`,
  );
  const groupOidById = new Map<string, string>();
  const mappings = rows.map((r) => {
    groupOidById.set(r.group_id, r.group_oid);
    // resolveAccess matches on groupId; we feed it the Entra oid so the user's
    // synced Entra group ids line up with the mappings.
    return { id: r.id, groupId: r.group_oid, namespaceId: r.namespace_id, role: r.role } satisfies RoleMapping;
  });
  return { mappings, groupOidById };
}

/**
 * Resolve a signed-in user's effective access. Returns null access for unknown users.
 * Honors SKILLY_BOOTSTRAP_ADMIN_GROUP so the very first platform admin exists before
 * any role_mappings are configured.
 */
export async function resolveUserAccess(entraOid: string): Promise<EffectiveAccess & { userId: string | null }> {
  return accessCache.get(entraOid, async () => {
    const [{ userId, groupEntraIds }, { mappings }] = await Promise.all([
      loadUserGroupIds(entraOid),
      roleMappingsCache.get("all", loadRoleMappings),
    ]);

    const access = resolveAccess(groupEntraIds, mappings);

    const bootstrapGroup = process.env.SKILLY_BOOTSTRAP_ADMIN_GROUP?.trim();
    if (bootstrapGroup && groupEntraIds.has(bootstrapGroup)) {
      access.isPlatformAdmin = true;
    }

    return { ...access, userId };
  });
}
