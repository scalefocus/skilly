// Platform-admin configuration: namespaces + Entra-group→role mappings. SKILLY_SPEC.md §4.
// All mutations are audit-logged. Roles still resolve from SCIM-synced membership; this
// only manages the (group → namespace → role) bindings.
import type { Pool } from "pg";
import type { Role } from "@skilly/shared";
import { appendAudit } from "./audit";
import { invalidateAccessCaches } from "./access";
import { getPlatformSettings, type PlatformSettings } from "./settings";

export interface RoleMappingView {
  id: string;
  role: Role;
  namespaceId: string | null;
  groupId: string;
  groupDisplayName: string;
  groupExternalId: string;
}
export interface NamespaceView {
  id: string;
  slug: string;
  displayName: string;
  requireReview: boolean;
  maintainerContact: string | null;
  mappings: RoleMappingView[];
}
export interface GroupView { id: string; externalId: string; displayName: string }

/** SCIM provisioning snapshot — drives the Administration "Identity sync" diagnostics panel.
 *  groupCount feeds the group-picker empty-state guidance (§5). */
export interface ScimStatus {
  groupCount: number;
  userCount: number;
  /** Most recent groups.updated_at (a SCIM-only write) as a UTC ISO string; null if no groups. */
  lastGroupSyncAt: string | null;
}

export interface AdminConfig {
  namespaces: NamespaceView[];
  /** total namespace count — drives the admin page's infinite scroll (pages of 100) */
  namespacesTotal: number;
  platformAdminMappings: RoleMappingView[];
  groups: GroupView[];
  scim: ScimStatus;
  settings: PlatformSettings;
}

export const NS_PAGE_SIZE = 100;

/** WHERE clause + params for namespace search (q matches slug/display name; review filters the flag). */
function nsFilter(q?: string, requireReview?: boolean): { where: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(slug ilike $${params.length} or display_name ilike $${params.length})`);
  }
  if (requireReview !== undefined) {
    params.push(requireReview);
    conds.push(`require_review = $${params.length}`);
  }
  return { where: conds.length ? `where ${conds.join(" and ")}` : "", params };
}

/** Filtered namespace count — pairs with listNamespacePage for the admin search/infinite scroll. */
export async function countNamespaces(pool: Pool, q?: string, requireReview?: boolean): Promise<number> {
  const f = nsFilter(q, requireReview);
  const { rows } = await pool.query<{ n: string }>(`select count(*)::text as n from namespaces ${f.where}`, f.params);
  return Number(rows[0]?.n ?? 0);
}

/** One slug-ordered page of namespaces with their role mappings (admin infinite scroll / search). */
export async function listNamespacePage(pool: Pool, offset: number, limit = NS_PAGE_SIZE, q?: string, requireReview?: boolean): Promise<NamespaceView[]> {
  const f = nsFilter(q, requireReview);
  const [nsRows, mappings] = await Promise.all([
    pool.query<{ id: string; slug: string; display_name: string; require_review: boolean; maintainer_contact: string | null }>(
      `select id, slug, display_name, require_review, maintainer_contact from namespaces ${f.where} order by slug limit $${f.params.length + 1} offset $${f.params.length + 2}`,
      [...f.params, Math.min(200, limit), Math.max(0, offset)],
    ),
    allMappings(pool),
  ]);
  const byNs = new Map<string, RoleMappingView[]>();
  for (const m of mappings) {
    if (m.namespaceId != null) (byNs.get(m.namespaceId) ?? byNs.set(m.namespaceId, []).get(m.namespaceId)!).push(m);
  }
  return nsRows.rows.map((n) => ({
    id: n.id,
    slug: n.slug,
    displayName: n.display_name,
    requireReview: n.require_review,
    maintainerContact: n.maintainer_contact,
    mappings: byNs.get(n.id) ?? [],
  }));
}

async function allMappings(pool: Pool): Promise<RoleMappingView[]> {
  const { rows } = await pool.query<{ id: string; role: Role; namespace_id: string | null; group_id: string; gname: string; goid: string }>(
    `select rm.id, rm.role, rm.namespace_id, rm.group_id, g.display_name as gname, g.entra_object_id as goid
       from role_mappings rm join groups g on g.id = rm.group_id`,
  );
  return rows.map((r) => ({ id: r.id, role: r.role, namespaceId: r.namespace_id, groupId: r.group_id, groupDisplayName: r.gname, groupExternalId: r.goid }));
}

/** Full admin config + the FIRST page of namespaces (further pages via listNamespacePage). */
export async function getAdminConfig(pool: Pool, nsLimit = NS_PAGE_SIZE): Promise<AdminConfig> {
  const [namespaces, total, mappings, groupRows, scimRow, settings] = await Promise.all([
    listNamespacePage(pool, 0, nsLimit),
    pool.query<{ n: string }>(`select count(*)::text as n from namespaces`),
    allMappings(pool),
    pool.query<{ id: string; entra_object_id: string; display_name: string }>(`select id, entra_object_id, display_name from groups order by display_name`),
    // SCIM snapshot for the Identity-sync panel: group + active-user counts and the latest group
    // sync. One round-trip; user count is active-only (deprovisioned users don't reflect a live sync).
    pool.query<{ groups: string; users: string; last_group: string | null }>(
      `select (select count(*) from groups)::text as groups,
              (select count(*) from users where status = 'active')::text as users,
              (select max(updated_at) from groups) as last_group`,
    ),
    getPlatformSettings(pool),
  ]);

  return {
    namespaces,
    namespacesTotal: Number(total.rows[0]?.n ?? 0),
    platformAdminMappings: mappings.filter((m) => m.namespaceId == null),
    groups: groupRows.rows.map((g) => ({ id: g.id, externalId: g.entra_object_id, displayName: g.display_name })),
    scim: {
      groupCount: Number(scimRow.rows[0]?.groups ?? 0),
      userCount: Number(scimRow.rows[0]?.users ?? 0),
      lastGroupSyncAt: scimRow.rows[0]?.last_group ?? null,
    },
    settings,
  };
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export async function createNamespace(
  pool: Pool,
  input: { slug: string; displayName: string; requireReview: boolean; maintainerContact?: string | null },
  actorUserId: string,
): Promise<{ id: string } | { error: string }> {
  if (!SLUG.test(input.slug)) return { error: "slug must be lowercase letters, digits, hyphens" };
  const exists = await pool.query(`select 1 from namespaces where slug = $1`, [input.slug]);
  if (exists.rowCount) return { error: `namespace '${input.slug}' already exists` };

  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review, maintainer_contact) values ($1,$2,$3,$4) returning id`,
      [input.slug, input.displayName, input.requireReview, input.maintainerContact ?? null],
    );
    const id = rows[0]!.id;
    await appendAudit(client, { actorUserId, action: "namespace.created", targetType: "namespace", targetId: id, namespaceId: id, after: input });
    await client.query("commit");
    return { id };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function updateNamespace(
  pool: Pool,
  id: string,
  patch: { requireReview?: boolean; maintainerContact?: string | null },
  actorUserId: string,
): Promise<{ error: string } | null> {
  // The global namespace is always require_review = true.
  const ns = (await pool.query<{ slug: string }>(`select slug from namespaces where id = $1`, [id])).rows[0];
  if (!ns) return { error: "namespace not found" };
  if (ns.slug === "global" && patch.requireReview === false) return { error: "global namespace always requires review" };

  await pool.query(
    `update namespaces set
       require_review = coalesce($2, require_review),
       maintainer_contact = coalesce($3, maintainer_contact)
     where id = $1`,
    [id, patch.requireReview ?? null, patch.maintainerContact ?? null],
  );
  await appendAudit(pool, { actorUserId, action: "namespace.updated", targetType: "namespace", targetId: id, namespaceId: id, after: patch });
  return null;
}

export async function createRoleMapping(
  pool: Pool,
  input: { groupId: string; namespaceId: string | null; role: Role },
  actorUserId: string,
): Promise<{ id: string } | { error: string }> {
  if (input.role === "platform_admin" && input.namespaceId != null) return { error: "platform_admin must not target a namespace" };
  if (input.role !== "platform_admin" && input.namespaceId == null) return { error: "namespace role requires a namespace" };
  try {
    const { rows } = await pool.query<{ id: string }>(
      `insert into role_mappings (group_id, namespace_id, role) values ($1,$2,$3) returning id`,
      [input.groupId, input.namespaceId, input.role],
    );
    const id = rows[0]!.id;
    await appendAudit(pool, { actorUserId, action: "role_mapping.created", targetType: "role_mapping", targetId: id, namespaceId: input.namespaceId, after: input });
    invalidateAccessCaches(); // reflect the new mapping on the next request
    return { id };
  } catch {
    return { error: "mapping already exists or references an unknown group" };
  }
}

export async function deleteRoleMapping(pool: Pool, id: string, actorUserId: string): Promise<void> {
  const before = (await pool.query(`select group_id, namespace_id, role from role_mappings where id = $1`, [id])).rows[0];
  await pool.query(`delete from role_mappings where id = $1`, [id]);
  await appendAudit(pool, { actorUserId, action: "role_mapping.deleted", targetType: "role_mapping", targetId: id, before });
  invalidateAccessCaches(); // drop the revoked mapping on the next request
}
