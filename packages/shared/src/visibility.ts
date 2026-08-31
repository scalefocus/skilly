// The skill-visibility SQL predicate and the DB-backed role-resolution queries, extracted so the
// web tier and the worker (the §29 MCP server) run ONE implementation of invariants #1 and #3.
//
// This is the §29 "prerequisite refactor": the MCP tools are implemented directly on the worker
// against Postgres rather than proxied through web's `/api`, so the *access decisions* must not be
// written twice. Result shaping/sorting/paging may differ between the two callers; who-can-see-what
// may not. SKILLY_SPEC.md §4, §10, §29.
import type { RoleMapping } from "./types.js";
import { resolveAccess, visibleNamespaceIds, type EffectiveAccess } from "./rbac.js";

/**
 * The one visibility predicate (invariant #3). Appends any needed parameter to `params` and
 * returns the SQL fragment to AND into a WHERE clause — or `null` for a platform admin, who sees
 * everything and therefore needs no predicate at all.
 *
 * `alias` is the table alias for `skills` in the caller's query (default `s`).
 *
 * Callers MUST treat `null` as "no restriction" and anything else as mandatory:
 *   const vis = skillVisibilityWhere(access, params); if (vis) where.push(vis);
 */
export function skillVisibilityWhere(
  access: Pick<EffectiveAccess, "isPlatformAdmin" | "namespaceRoles">,
  params: unknown[],
  alias = "s",
): string | null {
  if (access.isPlatformAdmin) return null;
  params.push(visibleNamespaceIds(access as EffectiveAccess));
  return `(${alias}.visibility = 'org' or ${alias}.namespace_id = any($${params.length}::uuid[]))`;
}

// ── DB-backed role resolution (invariant #1: SCIM groups × role_mappings, never token claims) ──

/** Row shape returned by both user-group queries below. */
export interface UserGroupRow {
  user_id: string;
  group_oid: string | null;
}

/** Row shape returned by {@link SQL_ROLE_MAPPINGS}. */
export interface RoleMappingRow {
  id: string;
  namespace_id: string | null;
  role: RoleMapping["role"];
  group_id: string;
  group_oid: string;
}

/**
 * Look up the internal user + their synced Entra group ids by **Entra object id** (the `oid` claim
 * from OIDC). Used by the web tier, where the session carries an oid. Active users only.
 */
export const SQL_USER_GROUPS_BY_OID = `select u.id as user_id, g.entra_object_id as group_oid
   from users u
   left join group_memberships gm on gm.user_id = u.id
   left join groups g on g.id = gm.group_id
  where u.entra_object_id = $1 and u.status = 'active'`;

/**
 * The same lookup keyed by the **internal user id**. Used by the worker's MCP server, where an
 * OAuth access token resolves to a `users.id` and there is no OIDC token in play at all. The
 * `status = 'active'` clause is what makes a leaver's live token resolve to no access.
 */
export const SQL_USER_GROUPS_BY_ID = `select u.id as user_id, g.entra_object_id as group_oid
   from users u
   left join group_memberships gm on gm.user_id = u.id
   left join groups g on g.id = gm.group_id
  where u.id = $1 and u.status = 'active'`;

/** All role mappings, joined to their group's Entra object id (what we match membership against). */
export const SQL_ROLE_MAPPINGS = `select rm.id, rm.namespace_id, rm.role, rm.group_id, g.entra_object_id as group_oid
   from role_mappings rm
   join groups g on g.id = rm.group_id`;

/** Fold {@link SQL_USER_GROUPS_BY_OID}/`_BY_ID` rows into the user id + their Entra group id set. */
export function userGroupsFromRows(rows: readonly UserGroupRow[]): {
  userId: string | null;
  groupEntraIds: Set<string>;
} {
  const userId = rows[0]?.user_id ?? null;
  const groupEntraIds = new Set<string>();
  for (const r of rows) if (r.group_oid) groupEntraIds.add(r.group_oid);
  return { userId, groupEntraIds };
}

/**
 * Fold {@link SQL_ROLE_MAPPINGS} rows into `RoleMapping`s keyed by the Entra group **oid**, so a
 * user's synced Entra group ids line up with the mappings inside `resolveAccess`.
 */
export function roleMappingsFromRows(rows: readonly RoleMappingRow[]): {
  mappings: RoleMapping[];
  groupOidById: Map<string, string>;
} {
  const groupOidById = new Map<string, string>();
  const mappings = rows.map((r) => {
    groupOidById.set(r.group_id, r.group_oid);
    return { id: r.id, groupId: r.group_oid, namespaceId: r.namespace_id, role: r.role } satisfies RoleMapping;
  });
  return { mappings, groupOidById };
}

/**
 * Resolve effective access from already-loaded rows — the pure core both tiers share, including the
 * bootstrap-admin escape hatch (§5 first-admin chicken-and-egg) so it can't be honored in one tier
 * and forgotten in the other.
 */
export function accessFromRows(
  userRows: readonly UserGroupRow[],
  mappingRows: readonly RoleMappingRow[],
  bootstrapAdminGroup?: string | null,
): EffectiveAccess & { userId: string | null } {
  const { userId, groupEntraIds } = userGroupsFromRows(userRows);
  const { mappings } = roleMappingsFromRows(mappingRows);
  const access = resolveAccess(groupEntraIds, mappings);
  const bootstrap = bootstrapAdminGroup?.trim();
  if (bootstrap && groupEntraIds.has(bootstrap)) access.isPlatformAdmin = true;
  return { ...access, userId };
}
