// Skill deprecation with a successor — the web tier's write path, fan-out and read shaping
// (SKILLY_SPEC.md §45). Authority = archive's (`canYankOrArchive`: platform admin, or an admin of
// the OWNING namespace). The pure rules (successor eligibility, note cap, hint text) live in
// `@skilly/shared/deprecation`; this file is the DB glue.
import type { Pool, PoolClient } from "pg";
import {
  canYankOrArchive,
  isSkillVisible,
  normalizeDeprecationNote,
  skillVisibilityWhere,
  successorEligibility,
  successorIneligibleMessage,
  successorJsonSql,
  userCanSeeSkillSql,
  visibleSuccessor,
  type DeprecationLite,
  type EffectiveAccess,
  type SuccessorIneligibleReason,
  type SuccessorJson,
} from "@skilly/shared";
import { pool as defaultPool } from "./db";
import { appendAudit } from "./audit";
import { findSkill, iconView, type SkillRow, type SkillIconView } from "./catalog";

/** `successorState` tells admins WHY no successor renders; everyone else only ever sees `hidden`. */
export type SuccessorState = "ok" | "hidden" | "archived" | "deprecated" | "none";

export interface DeprecationDetail {
  deprecatedAt: string;
  deprecatedBy: { id: string; displayName: string } | null;
  note: string | null;
  successor: { namespaceSlug: string; skillSlug: string; title: string; icon: SkillIconView | null; installable: boolean } | null;
  successorState: SuccessorState;
}

/** The detail-page payload (§45.8) — null when the skill is not deprecated. */
export function deprecationDetail(access: EffectiveAccess, skill: SkillRow, canDeprecate: boolean): DeprecationDetail | null {
  if (!skill.deprecatedAt) return null;
  const raw = skill.successor;
  const vis = visibleSuccessor(access, raw);
  let state: SuccessorState;
  if (!raw) state = "none";
  else if (vis) state = "ok";
  else if (!canDeprecate) state = "hidden";
  else if (raw.status !== "active") state = "archived";
  else state = "hidden";
  // A chain (the successor is itself deprecated) renders normally for viewers; admins get the hint.
  if (vis && raw?.deprecatedAt && canDeprecate) state = "deprecated";
  return {
    deprecatedAt: skill.deprecatedAt,
    deprecatedBy: skill.deprecatedBy,
    note: skill.deprecationNote,
    successor: vis
      ? { namespaceSlug: vis.namespaceSlug, skillSlug: vis.slug, title: vis.title, icon: iconView(vis.iconSha256, vis.iconEmoji), installable: vis.installable }
      : null,
    successorState: state,
  };
}

/** Skills that name `skillId` as their successor and that the viewer can see — the "Replaces …" line. */
export async function listReplaces(access: EffectiveAccess, skillId: string, pool: Pool = defaultPool): Promise<Array<{ namespaceSlug: string; skillSlug: string; title: string }>> {
  const params: unknown[] = [skillId];
  const where = ["s.successor_skill_id = $1", "s.status = 'active'", "s.deprecated_at is not null"];
  const vis = skillVisibilityWhere(access, params);
  if (vis) where.push(vis);
  const { rows } = await pool.query<{ namespace_slug: string; slug: string; title: string }>(
    `select n.slug as namespace_slug, s.slug, s.title from skills s join namespaces n on n.id = s.namespace_id
      where ${where.join(" and ")} order by s.title asc`,
    params,
  );
  return rows.map((r) => ({ namespaceSlug: r.namespace_slug, skillSlug: r.slug, title: r.title }));
}

type SetResult =
  | { ok: true; deprecation: DeprecationDetail | null; changedSuccessor: boolean }
  | { ok: false; status: number; error: string; reason?: SuccessorIneligibleReason | "note_too_long" | "archived" };

/** Resolve a `ns/slug` candidate the ACTOR can see (invisible ⇒ not_found, never distinguished). */
async function loadCandidate(pool: Pool, access: EffectiveAccess, ref: string): Promise<SuccessorJson | null> {
  const [ns, slug] = ref.split("/");
  if (!ns || !slug) return null;
  const params: unknown[] = [ns, slug];
  const where = ["n.slug = $1", "s.slug = $2"];
  const vis = skillVisibilityWhere(access, params);
  if (vis) where.push(vis);
  const { rows } = await pool.query<{ j: SuccessorJson }>(
    `select ${successorJsonSql("p")} as j from (select s.id as successor_skill_id from skills s join namespaces n on n.id = s.namespace_id where ${where.join(" and ")}) p`,
    params,
  );
  return rows[0]?.j ?? null;
}

/**
 * Deprecate a skill, or edit its deprecation (§45.3). Idempotent on the stored columns; the
 * original `deprecated_at` / `deprecated_by` survive an edit. Notifies on a NEW deprecation and
 * whenever the successor changes (never on a note-only edit).
 */
export async function setSkillDeprecation(
  pool: Pool,
  input: { access: EffectiveAccess; actorUserId: string; namespaceSlug: string; skillSlug: string; successor: string | null; note: unknown },
): Promise<SetResult> {
  const skill = await findSkill(input.namespaceSlug, input.skillSlug);
  if (!skill || (skill.status === "active" && !isSkillVisible(input.access, skill))) return { ok: false, status: 404, error: "skill not found" };
  if (!canYankOrArchive(input.access, skill.namespaceId)) return { ok: false, status: 403, error: "not authorized to manage this namespace" };
  if (skill.status === "archived") return { ok: false, status: 409, error: "an archived skill can't be deprecated — restore it first", reason: "archived" };

  const note = normalizeDeprecationNote(input.note);
  if (!note.ok) return { ok: false, status: 422, error: note.error, reason: "note_too_long" };

  let successor: SuccessorJson | null = null;
  if (input.successor) {
    successor = await loadCandidate(pool, input.access, input.successor.trim());
    if (!successor) return { ok: false, status: 422, error: successorIneligibleMessage("not_found"), reason: "not_found" };
    const elig = successorEligibility(
      { id: skill.id, visibility: skill.visibility, namespaceId: skill.namespaceId, sharedNamespaceIds: skill.sharedNamespaceIds },
      { ...successor, sharedNamespaceIds: successor.sharedNamespaceIds },
    );
    if (!elig.ok) return { ok: false, status: 422, error: successorIneligibleMessage(elig.reason), reason: elig.reason };
  }

  const fresh = !skill.deprecatedAt;
  const previousSuccessorId = skill.successor?.id ?? null;
  const changedSuccessor = fresh || previousSuccessorId !== (successor?.id ?? null);

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `update skills
          set deprecated_at = coalesce(deprecated_at, now()),
              deprecated_by = case when deprecated_at is null then $2::uuid else deprecated_by end,
              successor_skill_id = $3,
              deprecation_note = $4
        where id = $1`,
      [skill.id, input.actorUserId, successor?.id ?? null, note.note],
    );
    await appendAudit(client, {
      actorUserId: input.actorUserId,
      action: "skill.deprecated",
      targetType: "skill",
      targetId: skill.id,
      namespaceId: skill.namespaceId,
      before: fresh ? undefined : { successorSkillId: previousSuccessorId, note: skill.deprecationNote },
      after: {
        successorSkillId: successor?.id ?? null,
        successorSlug: successor ? `${successor.namespaceSlug}/${successor.slug}` : null,
        note: note.note,
        ...(fresh ? {} : { previousSuccessorSkillId: previousSuccessorId, edit: true }),
      },
    });
    // Deprecating clears Featured (§7/§45.3) — a retired skill is never spotlighted.
    if (fresh && skill.featured) {
      await client.query(`update skills set featured_at = null, featured_by = null where id = $1`, [skill.id]);
      await appendAudit(client, {
        actorUserId: input.actorUserId,
        action: "skill.unfeatured",
        targetType: "skill",
        targetId: skill.id,
        namespaceId: skill.namespaceId,
        after: { featured: false, reason: "deprecated" },
      });
    }
    if (changedSuccessor) await notifyDeprecated(client, skill.id, input.actorUserId);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const after = await findSkill(input.namespaceSlug, input.skillSlug);
  return { ok: true, deprecation: after ? deprecationDetail(input.access, after, true) : null, changedSuccessor };
}

/** Un-deprecate (§45.3): clears all four columns, audits, notifies nobody. Idempotent. */
export async function clearSkillDeprecation(
  pool: Pool,
  input: { access: EffectiveAccess; actorUserId: string; namespaceSlug: string; skillSlug: string },
): Promise<{ ok: true; cleared: boolean } | { ok: false; status: number; error: string }> {
  const skill = await findSkill(input.namespaceSlug, input.skillSlug);
  if (!skill || (skill.status === "active" && !isSkillVisible(input.access, skill))) return { ok: false, status: 404, error: "skill not found" };
  if (!canYankOrArchive(input.access, skill.namespaceId)) return { ok: false, status: 403, error: "not authorized to manage this namespace" };
  if (!skill.deprecatedAt) return { ok: true, cleared: false };
  await pool.query(
    `update skills set deprecated_at = null, deprecated_by = null, successor_skill_id = null, deprecation_note = null where id = $1`,
    [skill.id],
  );
  await appendAudit(pool, {
    actorUserId: input.actorUserId,
    action: "skill.undeprecated",
    targetType: "skill",
    targetId: skill.id,
    namespaceId: skill.namespaceId,
    before: { successorSkillId: skill.successor?.id ?? null, note: skill.deprecationNote },
    after: { deprecated: false },
  });
  return { ok: true, cleared: true };
}

/**
 * `skill.deprecated` fan-out (§45.6): explicit watchers ∪ effective maintainers (explicit rows +
 * live namespace admins) ∪ current installers (used, non-expired personal install tokens) ∪ the
 * minting admins of active system installs. Minus the actor, one row per user, visibility-filtered
 * at insert; the successor is named only for recipients who can see it.
 */
export async function notifyDeprecated(client: PoolClient | Pool, skillId: string, actorUserId: string | null): Promise<number> {
  const { rowCount } = await client.query(
    `with meta as (
       select s.id, s.slug as skill_slug, n.slug as ns_slug, s.title as skill_title, s.deprecation_note,
              x.id as succ_id, xn.slug as succ_ns, x.slug as succ_slug, x.title as succ_title
         from skills s
         join namespaces n on n.id = s.namespace_id
         left join skills x on x.id = s.successor_skill_id and x.status = 'active'
         left join namespaces xn on xn.id = x.namespace_id
        where s.id = $1
     ), candidates as (
       select w.user_id from skill_watches w where w.skill_id = $1
       union
       select sm.user_id from skill_maintainers sm where sm.skill_id = $1
       union
       select gm.user_id
         from skills s
         join role_mappings rm on rm.namespace_id = s.namespace_id and rm.role = 'namespace_admin'
         join group_memberships gm on gm.group_id = rm.group_id
        where s.id = $1
       union
       select t.user_id from tokens t
        where t.skill_id = $1 and t.type = 'install' and t.used_at is not null and t.user_id is not null
          and (t.expires_at is null or t.expires_at > now())
       union
       select t.created_by_user_id from tokens t
        where t.skill_id = $1 and t.type = 'install' and t.is_system and t.used_at is not null
          and t.created_by_user_id is not null and (t.expires_at is null or t.expires_at > now())
     ), recipients as (
       select distinct u.id
         from candidates c
         join users u on u.id = c.user_id and u.status = 'active'
        where ($2::uuid is null or u.id <> $2::uuid)
          and exists (select 1 from skills s where s.id = $1 and ${userCanSeeSkillSql("u.id", "s")})
     )
     insert into notifications (user_id, type, payload)
     select r.id, 'skill.deprecated',
            jsonb_build_object(
              'namespaceSlug', m.ns_slug, 'skillSlug', m.skill_slug, 'skillTitle', m.skill_title, 'note', m.deprecation_note,
              'successorNamespaceSlug', case when m.succ_id is not null and exists (select 1 from skills x where x.id = m.succ_id and ${userCanSeeSkillSql("r.id", "x")}) then m.succ_ns end,
              'successorSlug',          case when m.succ_id is not null and exists (select 1 from skills x where x.id = m.succ_id and ${userCanSeeSkillSql("r.id", "x")}) then m.succ_slug end,
              'successorTitle',         case when m.succ_id is not null and exists (select 1 from skills x where x.id = m.succ_id and ${userCanSeeSkillSql("r.id", "x")}) then m.succ_title end)
       from recipients r cross join meta m`,
    [skillId, actorUserId],
  );
  return rowCount ?? 0;
}

export interface SuccessorSuggestion {
  id: string;
  namespaceSlug: string;
  skillSlug: string;
  title: string;
  icon: SkillIconView | null;
}

/**
 * The successor picker (§45.3): substring name matching over skills the ACTOR can see, active,
 * not deprecated, not the skill itself — then the audience rule in memory. At most `limit` rows.
 */
export async function suggestSuccessors(access: EffectiveAccess, forSkill: SkillRow, q: string, limit = 8, pool: Pool = defaultPool): Promise<SuccessorSuggestion[]> {
  const params: unknown[] = [forSkill.id, `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`];
  const where = ["s.status = 'active'", "s.deprecated_at is null", "s.id <> $1", "(s.title ilike $2 or s.slug ilike $2)"];
  const vis = skillVisibilityWhere(access, params);
  if (vis) where.push(vis);
  const { rows } = await pool.query<{ j: SuccessorJson }>(
    `select ${successorJsonSql("p")} as j
       from (select s.id as successor_skill_id, s.title, s.install_count from skills s join namespaces n on n.id = s.namespace_id where ${where.join(" and ")}) p
      order by case when p.title ilike $2 then 0 else 1 end asc, p.install_count desc, p.title asc
      limit 40`,
    params,
  );
  const subject = { id: forSkill.id, visibility: forSkill.visibility, namespaceId: forSkill.namespaceId, sharedNamespaceIds: forSkill.sharedNamespaceIds };
  return rows
    .map((r) => r.j)
    .filter((c) => successorEligibility(subject, c).ok)
    .slice(0, Math.min(10, Math.max(1, limit)))
    .map((c) => ({ id: c.id, namespaceSlug: c.namespaceSlug, skillSlug: c.slug, title: c.title, icon: iconView(c.iconSha256, c.iconEmoji) }));
}

export type { DeprecationLite };
