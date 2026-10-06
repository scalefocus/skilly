// Per-skill maintainers (SKILLY_SPEC.md §19). Ownership + notification layer; grants no
// authority (invariant #1) beyond curating the co-maintainer list. Effective set =
// (namespace admins of the skill's namespace, resolved live from role_mappings) ∪ the
// explicit skill_maintainers list. Every add/remove is audited.
import type { PoolClient } from "pg";
import { userCanSeeSkillSql, type EffectiveAccess } from "@skilly/shared";
import { pool } from "./db";
import { appendAudit } from "./audit";
import { awardAchievement, tryAward, isOriginalProposer } from "./achievements";
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

// Can user `u` see the skill bound at `$skillParam`? The shared per-user twin of isSkillVisible:
// org, platform admin, or any role in the owning namespace OR a §42 grantee namespace. Used as the
// eligibility + read-time filter. Reads the skill's CURRENT visibility + grants from the DB, so a
// caller's possibly-stale MaintainerSkill.visibility never decides eligibility.
const eligibleSql = (userExpr: string, skillParam: string) =>
  `exists (select 1 from skills sk where sk.id = ${skillParam} and ${userCanSeeSkillSql(userExpr, "sk")})`;

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
          and ${eligibleSql("u.id", "$1")}`,
      [skill.id],
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
  const { rows } = await pool.query<{ ok: boolean }>(
    `select exists (select 1 from users where id = $1 and status = 'active') and ${eligibleSql("$1::uuid", "$2::uuid")} as ok`,
    [userId, skill.id],
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
  // §31 Adopted: a maintainer of a skill they did not originally propose. Being added is not the
  // user's own action, so no Habits evaluation.
  if (!(await isOriginalProposer(pool, skill.id, userId))) await tryAward(pool, userId, "maintainer_added", { noHabits: true });
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
        and not exists (select 1 from skill_maintainers sm where sm.skill_id = $2 and sm.user_id = u.id)
        and ${eligibleSql("u.id", "$2")}
      order by u.display_name asc
      limit $3`,
    [like, skill.id, limit],
  );
  return rows.map((r) => ({ userId: r.id, displayName: userLabel(r.display_name, r.email), email: r.email, avatar: r.avatar }));
}

/** Shared eligibility check for the auto-add triggers below: can `userId` currently see `skill`? (invariant #3) */
async function isEligibleForAutoAdd(client: PoolClient, skill: MaintainerSkill, userId: string): Promise<boolean> {
  // Runs inside the materialize transaction on `client`, so a just-inserted skill row and its
  // just-synced §42 grants are visible to this probe.
  const { rows } = await client.query<{ ok: boolean }>(`select ${eligibleSql("$1::uuid", "$2::uuid")} as ok`, [userId, skill.id]);
  return rows[0]?.ok === true;
}

/**
 * §42.4 / §19: after a grant is revoked, remove every EXPLICIT maintainer of the skill who can no
 * longer see it, in the caller's transaction, each audited `skill.maintainer_removed`. Returns the
 * removed user ids. Actor = whoever revoked (null for a system cascade).
 */
export async function pruneIneligibleMaintainers(client: PoolClient, skill: MaintainerSkill, actorUserId: string | null, via: string): Promise<string[]> {
  const { rows } = await client.query<{ user_id: string }>(
    `delete from skill_maintainers sm
      where sm.skill_id = $1
        and not ${eligibleSql("sm.user_id", "$1")}
      returning sm.user_id`,
    [skill.id],
  );
  for (const r of rows) {
    await appendAudit(client, {
      actorUserId,
      action: "skill.maintainer_removed",
      targetType: "skill",
      targetId: skill.id,
      namespaceId: skill.namespaceId,
      before: { userId: r.user_id },
      after: { reason: "no_longer_visible", via },
    });
  }
  return rows.map((r) => r.user_id);
}

/** True if `userId` is already an IMPLICIT maintainer of `skill` (a namespace admin of its own
 *  namespace) — used by the version-acceptance trigger below to skip a redundant explicit row. */
async function isImplicitMaintainer(client: PoolClient, skill: MaintainerSkill, userId: string): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>(
    `select exists (
       select 1 from group_memberships gm
       join role_mappings rm on rm.group_id = gm.group_id
       where gm.user_id = $1 and rm.role = 'namespace_admin' and rm.namespace_id = $2
     ) as ok`,
    [userId, skill.namespaceId],
  );
  return rows[0]?.ok === true;
}

/**
 * Auto-add the proposal submitter as a maintainer of a newly created skill, iff they're
 * eligible to see it. Runs inside the materialize transaction. SKILLY_SPEC.md §19.
 */
export async function autoAddSubmitter(client: PoolClient, skill: MaintainerSkill, userId: string): Promise<void> {
  if (!(await isEligibleForAutoAdd(client, skill, userId))) return;
  await client.query(
    `insert into skill_maintainers (skill_id, user_id, added_by) values ($1, $2, $2) on conflict do nothing`,
    [skill.id, userId],
  );
}

/**
 * Auto-add the submitter of an ACCEPTED NEW VERSION of an already-existing skill as an explicit
 * maintainer — the version-acceptance trigger (SKILLY_SPEC.md §19), a second trigger alongside
 * `autoAddSubmitter` above (creation-only). Fires identically for a reviewed-proposal accept, a
 * direct publish, or a metadata-only "Keep current files" re-version — materializeVersion calls
 * this from the single existing-skill branch shared by all three. Same eligibility gate as
 * creation, checked at accept time against the skill's CURRENT namespace/visibility (a re-version
 * never changes either, so this is always the live row, not stale submission-time state). A
 * no-op, with no audit entry, when the submitter is already an effective maintainer — explicit
 * (unique-conflict) or implicit (already a namespace admin, where an explicit row would be
 * redundant). Full parity with a manually-added maintainer once added: no cap, no expiry, the
 * usual co-maintainer curation rights. Audited as a DISTINCT action (`skill.maintainer_auto_added`,
 * actor = the submitter) so it stays distinguishable from an admin's manual add.
 */
export async function autoAddSubmitterOnNewVersion(client: PoolClient, skill: MaintainerSkill, userId: string): Promise<void> {
  if (!(await isEligibleForAutoAdd(client, skill, userId))) return;
  if (await isImplicitMaintainer(client, skill, userId)) return;
  const { rowCount } = await client.query(
    `insert into skill_maintainers (skill_id, user_id, added_by) values ($1, $2, $2) on conflict do nothing`,
    [skill.id, userId],
  );
  if (!rowCount) return;
  await appendAudit(client, {
    actorUserId: userId,
    action: "skill.maintainer_auto_added",
    targetType: "skill",
    targetId: skill.id,
    namespaceId: skill.namespaceId,
    after: { userId },
  });
  // §31 Adopted (same rule as a manual add; the version publish already counted the Habits event).
  if (!(await isOriginalProposer(client, skill.id, userId))) await awardAchievement(client, userId, "maintainer_added", { noHabits: true });
}
