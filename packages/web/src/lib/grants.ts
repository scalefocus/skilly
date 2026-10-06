// Sharing a restricted skill with other namespaces (SKILLY_SPEC.md §42).
//
// One owner (skills.namespace_id), N grantee namespaces (skill_namespace_grants). A grant confers
// VISIBILITY only, never a role (invariant #1). Every add/remove — from the detail page's Shared
// with card, a proposal accept, a direct publish — goes through this module so the audit pair
// (`skill.namespace_shared` / `skill.namespace_unshared`, with `via`), the `skill.shared`
// notification and the §19 maintainer pruning can never be skipped.
import type { Pool, PoolClient } from "pg";
import { pool } from "./db";
import { appendAudit } from "./audit";
import { pruneIneligibleMaintainers } from "./maintainers";

export type GrantVia = "manage" | "proposal_accept" | "direct_publish" | "reviewer_edit" | "namespace_deleted" | "visibility_org";

export interface GrantSkill {
  id: string;
  namespaceId: string;
  visibility: "org" | "namespace";
}

export interface GrantView {
  namespaceId: string;
  slug: string;
  displayName: string;
  grantedAt: string;
  grantedBy: string | null;
}

/** The skill's grantee namespaces, display-name ordered. */
export async function listGrants(skillId: string, db: Pool | PoolClient = pool): Promise<GrantView[]> {
  const { rows } = await db.query<{ namespace_id: string; slug: string; display_name: string; granted_at: string; granted_by_name: string | null }>(
    `select g.namespace_id, n.slug, n.display_name, g.granted_at,
            coalesce(nullif(u.display_name, ''), u.email) as granted_by_name
       from skill_namespace_grants g
       join namespaces n on n.id = g.namespace_id
       left join users u on u.id = g.granted_by
      where g.skill_id = $1
      order by lower(n.display_name), n.slug`,
    [skillId],
  );
  return rows.map((r) => ({ namespaceId: r.namespace_id, slug: r.slug, displayName: r.display_name, grantedAt: r.granted_at, grantedBy: r.granted_by_name }));
}

/** Explicit `skill_maintainers` membership — the third leg of the §42.2 share authority. */
export async function isExplicitMaintainer(skillId: string, userId: string | null, db: Pool | PoolClient = pool): Promise<boolean> {
  if (!userId) return false;
  const { rowCount } = await db.query(`select 1 from skill_maintainers where skill_id = $1 and user_id = $2`, [skillId, userId]);
  return (rowCount ?? 0) > 0;
}

export type GrantTargetError = "unknown_namespace" | "owner_namespace" | "global_namespace";

/**
 * Validate and normalize a requested grantee list for a skill owned by `owningNamespaceId`:
 * de-duplicated; every id must be an existing namespace that is neither the owner nor `global`.
 * Returns the cleaned list or the first violation.
 */
export async function validateGrantTargets(
  db: Pool | PoolClient,
  owningNamespaceId: string | null,
  requested: readonly string[],
): Promise<{ ok: true; ids: string[] } | { ok: false; error: GrantTargetError; namespaceId: string }> {
  const ids = [...new Set(requested.map((s) => String(s).trim()).filter(Boolean))];
  if (ids.length === 0) return { ok: true, ids };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const bad = ids.find((id) => !uuid.test(id));
  if (bad) return { ok: false, error: "unknown_namespace", namespaceId: bad };
  const { rows } = await db.query<{ id: string; slug: string }>(`select id, slug from namespaces where id = any($1::uuid[])`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r.slug]));
  for (const id of ids) {
    const slug = byId.get(id);
    if (slug === undefined) return { ok: false, error: "unknown_namespace", namespaceId: id };
    if (id === owningNamespaceId) return { ok: false, error: "owner_namespace", namespaceId: id };
    if (slug === "global") return { ok: false, error: "global_namespace", namespaceId: id };
  }
  return { ok: true, ids };
}

export const GRANT_TARGET_MESSAGES: Record<GrantTargetError, string> = {
  unknown_namespace: "one of the namespaces to share with doesn't exist",
  owner_namespace: "a skill is always visible to its own namespace — it can't be shared with it",
  global_namespace: "a skill can't be shared with the global namespace",
};

/** `skill.shared` to the receiving namespace's admins (not platform admins who merely inherit
 *  access), minus the actor. Awareness only — §12/§42.5. */
async function notifyShared(client: PoolClient, skill: GrantSkill, granteeNamespaceId: string, actorUserId: string | null): Promise<void> {
  await client.query(
    `with meta as (
       select s.slug as skill_slug, s.title as skill_title, own.slug as ns_slug, own.display_name as owner_name,
              tgt.display_name as grantee_name,
              (select coalesce(nullif(u.display_name, ''), u.email) from users u where u.id = $3::uuid) as from_name
         from skills s
         join namespaces own on own.id = s.namespace_id
         join namespaces tgt on tgt.id = $2::uuid
        where s.id = $1
     ), admins as (
       select distinct u.id
         from role_mappings rm
         join group_memberships gm on gm.group_id = rm.group_id
         join users u on u.id = gm.user_id
        where rm.namespace_id = $2::uuid and rm.role = 'namespace_admin' and u.status = 'active'
          and ($3::uuid is null or u.id <> $3::uuid)
     )
     insert into notifications (user_id, type, payload)
     select a.id, 'skill.shared',
            jsonb_build_object('namespaceSlug', m.ns_slug, 'skillSlug', m.skill_slug, 'skillTitle', m.skill_title,
                               'ownerNamespaceName', m.owner_name, 'granteeNamespaceName', m.grantee_name,
                               'granteeNamespaceId', $2::text, 'fromName', coalesce(m.from_name, 'Someone'))
       from admins a cross join meta m`,
    [skill.id, granteeNamespaceId, actorUserId],
  );
}

/** Add one grant (idempotent). Returns true when a row was created (and audited + notified). */
export async function addGrant(
  client: PoolClient,
  skill: GrantSkill,
  granteeNamespaceId: string,
  actorUserId: string | null,
  via: GrantVia,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `insert into skill_namespace_grants (skill_id, namespace_id, granted_by) values ($1, $2, $3)
     on conflict do nothing`,
    [skill.id, granteeNamespaceId, actorUserId],
  );
  if (!rowCount) return false;
  await appendAudit(client, {
    actorUserId,
    action: "skill.namespace_shared",
    targetType: "skill",
    targetId: skill.id,
    namespaceId: skill.namespaceId,
    after: { namespaceId: granteeNamespaceId, via },
  });
  await notifyShared(client, skill, granteeNamespaceId, actorUserId);
  return true;
}

/** Remove one grant (idempotent). On removal: audit + prune now-ineligible explicit maintainers. */
export async function removeGrant(
  client: PoolClient,
  skill: GrantSkill,
  granteeNamespaceId: string,
  actorUserId: string | null,
  via: GrantVia,
): Promise<{ removed: boolean; prunedMaintainers: string[] }> {
  const { rowCount } = await client.query(`delete from skill_namespace_grants where skill_id = $1 and namespace_id = $2`, [skill.id, granteeNamespaceId]);
  if (!rowCount) return { removed: false, prunedMaintainers: [] };
  await appendAudit(client, {
    actorUserId,
    action: "skill.namespace_unshared",
    targetType: "skill",
    targetId: skill.id,
    namespaceId: skill.namespaceId,
    before: { namespaceId: granteeNamespaceId },
    after: { via },
  });
  const prunedMaintainers = await pruneIneligibleMaintainers(client, skill, actorUserId, via);
  return { removed: true, prunedMaintainers };
}

/**
 * Add/remove grants so the skill's set equals `desired` (the proposal accept / direct publish sync,
 * §42.3 — the same add/remove-to-match shape as categories). An `org` skill has no grants: any rows
 * are cleared with `via = visibility_org`. Callers validate `desired` first (validateGrantTargets).
 */
export async function syncGrants(
  client: PoolClient,
  skill: GrantSkill,
  desired: readonly string[],
  actorUserId: string | null,
  via: GrantVia,
): Promise<{ added: string[]; removed: string[] }> {
  const { rows } = await client.query<{ namespace_id: string }>(`select namespace_id from skill_namespace_grants where skill_id = $1`, [skill.id]);
  const current = new Set(rows.map((r) => r.namespace_id));
  if (skill.visibility === "org") {
    const removed: string[] = [];
    for (const id of current) if ((await removeGrant(client, skill, id, actorUserId, "visibility_org")).removed) removed.push(id);
    return { added: [], removed };
  }
  const want = new Set(desired.filter((id) => id !== skill.namespaceId));
  const added: string[] = [];
  const removed: string[] = [];
  for (const id of want) if (!current.has(id) && (await addGrant(client, skill, id, actorUserId, via))) added.push(id);
  for (const id of current) if (!want.has(id) && (await removeGrant(client, skill, id, actorUserId, via)).removed) removed.push(id);
  return { added, removed };
}

/** Run `fn` in a transaction on a pooled client. */
export async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
