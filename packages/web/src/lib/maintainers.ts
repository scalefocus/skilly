// Per-skill maintainers (SKILLY_SPEC.md §19). Ownership + notification layer; grants no
// authority (invariant #1) beyond curating the co-maintainer list. Effective set =
// (namespace admins of the skill's namespace, resolved live from role_mappings) ∪ the
// explicit skill_maintainers list. Every add/remove is audited.
import type { PoolClient } from "pg";
import type { EffectiveAccess } from "@skilly/shared";
import { pool } from "./db";
import { appendAudit } from "./audit";
import { userLabel } from "./userLabel";

export interface MaintainerSkill {
  id: string;
  namespaceId: string;
  visibility: "org" | "namespace";
}
export interface MaintainerView {
  userId: string;
  displayName: string;
  email: string;
  /** Entra profile photo (data URI) captured at the user's own sign-in; null → initials bubble. */
  avatar: string | null;
  source: "admin" | "explicit"; // implicit namespace admin, or explicitly added
}

// A user can see a namespace-restricted skill iff they're a platform admin or hold any role
// in that namespace (mirrors isSkillVisible). Used as the eligibility + read-time filter.
const ELIGIBLE_EXISTS = `exists (
  select 1 from group_memberships gm
  join role_mappings rm on rm.group_id = gm.group_id
  where gm.user_id = u.id and (rm.role = 'platform_admin' or rm.namespace_id = $2)
)`;

/**
 * Effective maintainers for a skill: live namespace admins ∪ explicit users. For restricted
 * skills, explicit users are re-filtered through the visibility predicate (defense-in-depth,
 * so a stale row can never leak). Admins are always eligible by construction.
 */
export async function getEffectiveMaintainers(skill: MaintainerSkill): Promise<MaintainerView[]> {
  const [admins, explicit] = await Promise.all([
    pool.query<{ id: string; display_name: string; email: string; avatar: string | null }>(
      `select distinct u.id, u.display_name, u.email, u.avatar
         from role_mappings rm
         join group_memberships gm on gm.group_id = rm.group_id
         join users u on u.id = gm.user_id and u.status = 'active'
        where rm.namespace_id = $1 and rm.role = 'namespace_admin'`,
      [skill.namespaceId],
    ),
    pool.query<{ id: string; display_name: string; email: string; avatar: string | null }>(
      `select u.id, u.display_name, u.email, u.avatar
         from skill_maintainers sm
         join users u on u.id = sm.user_id and u.status = 'active'
        where sm.skill_id = $1
          and ($3 = 'org' or ${ELIGIBLE_EXISTS})`,
      [skill.id, skill.namespaceId, skill.visibility],
    ),
  ]);

  const byId = new Map<string, MaintainerView>();
  for (const r of admins.rows) byId.set(r.id, { userId: r.id, displayName: userLabel(r.display_name, r.email), email: r.email, avatar: r.avatar, source: "admin" });
  for (const r of explicit.rows) if (!byId.has(r.id)) byId.set(r.id, { userId: r.id, displayName: userLabel(r.display_name, r.email), email: r.email, avatar: r.avatar, source: "explicit" });

  return [...byId.values()].sort((a, b) => (a.source === b.source ? a.displayName.localeCompare(b.displayName) : a.source === "admin" ? -1 : 1));
}

/** True if `actor` may add/remove explicit maintainers: platform admin, this namespace's admin, or an existing maintainer of this skill (SKILLY_SPEC.md §19). */
export async function canManageMaintainers(access: EffectiveAccess, skill: MaintainerSkill, actorUserId: string): Promise<boolean> {
  if (access.isPlatformAdmin) return true;
  if (access.namespaceRoles.get(skill.namespaceId) === "namespace_admin") return true;
  const { rowCount } = await pool.query(`select 1 from skill_maintainers where skill_id = $1 and user_id = $2`, [skill.id, actorUserId]);
  return (rowCount ?? 0) > 0;
}

/** Who may remove a maintainer (SKILLY_SPEC.md §19): anyone who can manage the list — a platform
 *  admin, the namespace's admin, or one of the skill's own maintainers — may remove any *explicit*
 *  maintainer; self-removal is always allowed. (Implicit ns-admin entries aren't in the explicit
 *  list, so they can't be removed here.) */
export async function canRemoveMaintainer(access: EffectiveAccess, skill: MaintainerSkill, actorUserId: string, targetUserId: string): Promise<boolean> {
  return actorUserId === targetUserId || (await canManageMaintainers(access, skill, actorUserId));
}

/** Can this (existing, active) user *see* the skill — and thus be a maintainer? (invariant #3) */
async function userEligible(userId: string, skill: MaintainerSkill): Promise<boolean> {
  if (skill.visibility === "org") {
    const { rowCount } = await pool.query(`select 1 from users where id = $1 and status = 'active'`, [userId]);
    return (rowCount ?? 0) > 0;
  }
  const { rows } = await pool.query<{ ok: boolean }>(
    `select exists (
       select 1 from group_memberships gm
       join role_mappings rm on rm.group_id = gm.group_id
       where gm.user_id = $1 and (rm.role = 'platform_admin' or rm.namespace_id = $2)
     ) as ok`,
    [userId, skill.namespaceId],
  );
  return rows[0]?.ok ?? false;
}

export async function addMaintainer(actorUserId: string, skill: MaintainerSkill, userId: string): Promise<{ error: string } | null> {
  if (!(await userEligible(userId, skill))) return { error: "that user can't be a maintainer — they don't have access to this skill" };
  await pool.query(
    `insert into skill_maintainers (skill_id, user_id, added_by) values ($1, $2, $3) on conflict do nothing`,
    [skill.id, userId, actorUserId],
  );
  await appendAudit(pool, { actorUserId, action: "skill.maintainer_added", targetType: "skill", targetId: skill.id, namespaceId: skill.namespaceId, after: { userId } });
  return null;
}

export async function removeMaintainer(actorUserId: string, skill: MaintainerSkill, userId: string): Promise<void> {
  await pool.query(`delete from skill_maintainers where skill_id = $1 and user_id = $2`, [skill.id, userId]);
  await appendAudit(pool, { actorUserId, action: "skill.maintainer_removed", targetType: "skill", targetId: skill.id, namespaceId: skill.namespaceId, before: { userId } });
}

/** Eligible synced users matching `q`, excluding existing explicit maintainers — powers the picker typeahead. */
export async function listCandidates(skill: MaintainerSkill, q: string, limit = 10): Promise<{ userId: string; displayName: string; email: string; avatar: string | null }[]> {
  // Escape LIKE metacharacters so a query like "%" can't force a full-table scan / match-all.
  const like = `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await pool.query<{ id: string; display_name: string; email: string; avatar: string | null }>(
    `select u.id, u.display_name, u.email, u.avatar
       from users u
      where u.status = 'active'
        and (u.display_name ilike $1 escape '\\' or u.email ilike $1 escape '\\')
        and not exists (select 1 from skill_maintainers sm where sm.skill_id = $3 and sm.user_id = u.id)
        and ($4 = 'org' or ${ELIGIBLE_EXISTS})
      order by u.display_name asc
      limit $5`,
    [like, skill.namespaceId, skill.id, skill.visibility, limit],
  );
  return rows.map((r) => ({ userId: r.id, displayName: userLabel(r.display_name, r.email), email: r.email, avatar: r.avatar }));
}

/**
 * Auto-add the proposal submitter as a maintainer of a newly created skill, iff they're
 * eligible to see it. Runs inside the materialize transaction. SKILLY_SPEC.md §19.
 */
export async function autoAddSubmitter(client: PoolClient, skill: MaintainerSkill, userId: string): Promise<void> {
  const eligible =
    skill.visibility === "org"
      ? true
      : (
          await client.query(
            `select exists (
               select 1 from group_memberships gm
               join role_mappings rm on rm.group_id = gm.group_id
               where gm.user_id = $1 and (rm.role = 'platform_admin' or rm.namespace_id = $2)
             ) as ok`,
            [userId, skill.namespaceId],
          )
        ).rows[0]?.ok === true;
  if (!eligible) return;
  await client.query(
    `insert into skill_maintainers (skill_id, user_id, added_by) values ($1, $2, $2) on conflict do nothing`,
    [skill.id, userId],
  );
}
