// Skill lifecycle management: yank a version, archive/restore a skill, permanently delete a
// skill, mark a skill Official. SKILLY_SPEC.md §7. Authority: Namespace Admin (own ns) or Platform
// Admin (any) for yank/archive; PLATFORM ADMIN ONLY for permanent deletion and Official. All
// actions audit-logged.
import type { Pool } from "pg";
import { canYankOrArchive, type EffectiveAccess } from "@skilly/shared";
import { appendAudit } from "./audit";
import { findSkill } from "./catalog";
import { getMaxFeaturedSkills } from "./settings";

type Result = { ok: true } | { ok: false; status: number; error: string };

export async function setVersionYanked(
  pool: Pool,
  input: { access: EffectiveAccess; actorUserId: string; namespaceSlug: string; skillSlug: string; semver: string; yanked: boolean },
): Promise<Result> {
  const skill = await findSkill(input.namespaceSlug, input.skillSlug);
  if (!skill) return { ok: false, status: 404, error: "skill not found" };
  if (!canYankOrArchive(input.access, skill.namespaceId)) return { ok: false, status: 403, error: "not authorized to manage this namespace" };

  const status = input.yanked ? "yanked" : "active";
  const { rowCount } = await pool.query(
    `update skill_versions set status = $3 where skill_id = $1 and semver = $2`,
    [skill.id, input.semver, status],
  );
  if (!rowCount) return { ok: false, status: 404, error: "version not found" };
  await appendAudit(pool, {
    actorUserId: input.actorUserId,
    action: input.yanked ? "version.yanked" : "version.restored",
    targetType: "skill_version",
    targetId: `${skill.id}@${input.semver}`,
    namespaceId: skill.namespaceId,
    after: { semver: input.semver, status },
  });

  // Featured ⟹ installable (§7): if this yank left the skill with NO active version (all versions
  // yanked), drop it from the homepage Featured section. Clearing is permanent — re-publishing or
  // restoring a version does not re-feature it. The compensating un-feature is audited.
  if (input.yanked) {
    const { rowCount: activeLeft } = await pool.query(`select 1 from skill_versions where skill_id = $1 and status = 'active' limit 1`, [skill.id]);
    if (!activeLeft) {
      const { rowCount: cleared } = await pool.query(`update skills set featured_at = null, featured_by = null where id = $1 and featured_at is not null`, [skill.id]);
      if (cleared) {
        await appendAudit(pool, {
          actorUserId: input.actorUserId,
          action: "skill.unfeatured",
          targetType: "skill",
          targetId: skill.id,
          namespaceId: skill.namespaceId,
          after: { featured: false, reason: "all-versions-yanked" },
        });
      }
    }
  }
  return { ok: true };
}

export async function setSkillArchived(
  pool: Pool,
  input: { access: EffectiveAccess; actorUserId: string; namespaceSlug: string; skillSlug: string; archived: boolean },
): Promise<Result> {
  const skill = await findSkill(input.namespaceSlug, input.skillSlug);
  if (!skill) return { ok: false, status: 404, error: "skill not found" };
  if (!canYankOrArchive(input.access, skill.namespaceId)) return { ok: false, status: 403, error: "not authorized to manage this namespace" };

  const status = input.archived ? "archived" : "active";
  // Archiving withdraws the skill from the catalog → it also drops from the homepage Featured
  // section (§7): clear featured_at/featured_by in the same write. Restoring never re-features.
  if (input.archived) {
    await pool.query(`update skills set status = 'archived', featured_at = null, featured_by = null where id = $1`, [skill.id]);
  } else {
    await pool.query(`update skills set status = 'active' where id = $1`, [skill.id]);
  }
  await appendAudit(pool, {
    actorUserId: input.actorUserId,
    action: input.archived ? "skill.archived" : "skill.restored",
    targetType: "skill",
    targetId: skill.id,
    namespaceId: skill.namespaceId,
    after: { status },
  });
  // Emit the compensating un-feature entry only when archiving actually cleared a Featured flag.
  if (input.archived && skill.featured) {
    await appendAudit(pool, {
      actorUserId: input.actorUserId,
      action: "skill.unfeatured",
      targetType: "skill",
      targetId: skill.id,
      namespaceId: skill.namespaceId,
      after: { featured: false, reason: "archived" },
    });
  }
  return { ok: true };
}

/**
 * Mark / unmark a skill as **Official** — a platform-admin-only endorsement (SKILLY_SPEC.md §7).
 * Skill-level and persistent across future versions; purely a trust/display signal (no security or
 * gating change). On a fresh mark (not a re-mark) the skill's explicit maintainers are notified;
 * unmarking is silent. Every toggle is audit-logged. `official_at` doubles as the boolean.
 */
export async function setSkillOfficial(
  pool: Pool,
  input: { access: EffectiveAccess; actorUserId: string; namespaceSlug: string; skillSlug: string; official: boolean },
): Promise<Result> {
  const skill = await findSkill(input.namespaceSlug, input.skillSlug);
  if (!skill) return { ok: false, status: 404, error: "skill not found" };
  if (!input.access.isPlatformAdmin) return { ok: false, status: 403, error: "marking a skill Official is restricted to platform admins" };

  const wasOfficial = skill.official; // to notify only on a real transition to Official
  if (input.official) {
    // coalesce keeps the original timestamp if it was already Official (a re-mark just refreshes who).
    await pool.query(`update skills set official_at = coalesce(official_at, now()), official_by = $2 where id = $1`, [skill.id, input.actorUserId]);
    if (!wasOfficial) {
      // Positive signal to the skill's explicit maintainers (excluding the acting admin). The inbox
      // resolves the skill name from namespaceSlug/skillSlug (see notifications.ts). §12.
      await pool.query(
        `insert into notifications (user_id, type, payload)
         select sm.user_id, 'skill.marked_official', $2::jsonb
           from skill_maintainers sm
          where sm.skill_id = $1 and sm.user_id <> $3`,
        [skill.id, JSON.stringify({ namespaceSlug: skill.namespaceSlug, skillSlug: skill.slug }), input.actorUserId],
      );
    }
  } else {
    await pool.query(`update skills set official_at = null, official_by = null where id = $1`, [skill.id]);
  }
  await appendAudit(pool, {
    actorUserId: input.actorUserId,
    action: input.official ? "skill.marked_official" : "skill.unmarked_official",
    targetType: "skill",
    targetId: skill.id,
    namespaceId: skill.namespaceId,
    after: { official: input.official },
  });
  return { ok: true };
}

/**
 * Feature / un-feature a skill — a platform-admin-only homepage spotlight (SKILLY_SPEC.md §7).
 * Independent of Official; drives ONLY the "Featured skills" section on the home page (no badge,
 * no catalog/search influence). Featuring is allowed only for an active, installable skill and is
 * bounded by the `max_featured_skills` cap (a full cap returns 409). Silent — never notifies. Every
 * toggle is audit-logged. `featured_at` doubles as the boolean and the most-recent-first sort key.
 */
export async function setSkillFeatured(
  pool: Pool,
  input: { access: EffectiveAccess; actorUserId: string; namespaceSlug: string; skillSlug: string; featured: boolean },
): Promise<Result> {
  const skill = await findSkill(input.namespaceSlug, input.skillSlug);
  if (!skill) return { ok: false, status: 404, error: "skill not found" };
  if (!input.access.isPlatformAdmin) return { ok: false, status: 403, error: "featuring a skill is restricted to platform admins" };

  if (input.featured) {
    // Only re-check the gates on a genuine transition — a re-feature of an already-Featured skill
    // (e.g. a double click) is idempotent and must not spuriously 409 at a full cap.
    if (!skill.featured) {
      if (skill.status === "archived") return { ok: false, status: 409, error: "archived skills can't be featured — restore it first" };
      const { rowCount: installable } = await pool.query(
        `select 1 from skill_versions where skill_id = $1 and status = 'active' and git_published limit 1`,
        [skill.id],
      );
      if (!installable) return { ok: false, status: 409, error: "only a skill with a published, installable version can be featured" };
      const cap = await getMaxFeaturedSkills(pool);
      const { rows } = await pool.query<{ n: string }>(`select count(*)::text as n from skills where featured_at is not null`);
      if (Number(rows[0]?.n ?? 0) >= cap) {
        return { ok: false, status: 409, error: `${cap} skills are already featured. Remove one before spotlighting another.` };
      }
    }
    // coalesce keeps the original featured_at on a re-feature (order stays put); refreshes featured_by.
    await pool.query(`update skills set featured_at = coalesce(featured_at, now()), featured_by = $2 where id = $1`, [skill.id, input.actorUserId]);
  } else {
    await pool.query(`update skills set featured_at = null, featured_by = null where id = $1`, [skill.id]);
  }
  await appendAudit(pool, {
    actorUserId: input.actorUserId,
    action: input.featured ? "skill.featured" : "skill.unfeatured",
    targetType: "skill",
    targetId: skill.id,
    namespaceId: skill.namespaceId,
    after: { featured: input.featured },
  });
  return { ok: true };
}

/**
 * PERMANENTLY delete an archived skill and all its data — platform admins only. Removes the
 * skill row (cascading to versions, ratings, watches, categories, maintainers, usage_events,
 * pending_mirrors) plus the references that don't cascade (proposals, their review-discussion
 * conversations, scan reports, one-time tokens, provenance pointers, access-log links). The
 * append-only audit_log is preserved and gains a `skill.deleted` entry. Irreversible. The skill
 * must be archived first (§7).
 *
 * The on-disk git repo on the worker is left in place; with the DB rows gone the git gateway
 * can no longer authorize it (it resolves the skill from the DB), so it is unreachable — disk
 * reclamation is a separate ops/worker concern.
 */
export async function deleteSkill(
  pool: Pool,
  input: { access: EffectiveAccess; actorUserId: string; namespaceSlug: string; skillSlug: string },
): Promise<Result> {
  const skill = await findSkill(input.namespaceSlug, input.skillSlug);
  if (!skill) return { ok: false, status: 404, error: "skill not found" };
  if (!input.access.isPlatformAdmin) return { ok: false, status: 403, error: "permanent deletion is restricted to platform admins" };
  if (skill.status !== "archived") return { ok: false, status: 409, error: "archive the skill before deleting it" };

  const client = await pool.connect();
  try {
    await client.query("begin");
    // Open the version-immutability guard for THIS transaction only (migration 0022) so the
    // cascade from skills → skill_versions is permitted.
    await client.query("set local skilly.allow_version_delete = 'on'");

    // Detach the references that DON'T cascade, so the skill delete can't be blocked:
    //  - other skills whose provenance points at one of this skill's versions → drop the pointer
    await client.query(
      `update skills set promoted_from_skill_version_id = null
        where promoted_from_skill_version_id in (select id from skill_versions where skill_id = $1)`,
      [skill.id],
    );
    //  - access-log fetch records linked to this skill's versions → keep the log, drop the link
    await client.query(
      `update access_log set skill_version_id = null
        where skill_version_id in (select id from skill_versions where skill_id = $1)`,
      [skill.id],
    );
    //  - review-discussion conversations attached to those proposals (polymorphic context, no FK,
    //    so they don't cascade): delete them (messages + participants cascade) and the dangling
    //    message.new alerts that point at them, so a deleted skill's threads don't linger as
    //    "@null/?" conversations in the messages UI. §24. Done BEFORE the proposals go.
    const { rows: doomedProposals } = await client.query<{ id: string }>(
      `select id from proposals
        where target_skill_id = $1
           or materialized_version_id in (select id from skill_versions where skill_id = $1)`,
      [skill.id],
    );
    const proposalIds = doomedProposals.map((r) => r.id);
    if (proposalIds.length) {
      const { rows: doomedConvs } = await client.query<{ id: string }>(
        `delete from conversations where subject_type = 'proposal' and subject_id = any($1::uuid[]) returning id`,
        [proposalIds],
      );
      const convIds = doomedConvs.map((c) => c.id);
      if (convIds.length) {
        await client.query(
          `delete from notifications where type = 'message.new' and payload->>'conversationId' = any($1::text[])`,
          [convIds],
        );
      }
    }
    //  - proposals targeting this skill or that materialized one of its versions (revisions cascade)
    await client.query(
      `delete from proposals
        where target_skill_id = $1
           or materialized_version_id in (select id from skill_versions where skill_id = $1)`,
      [skill.id],
    );
    //  - scan reports cached against this skill's versions (subject_id holds the version id)
    await client.query(
      `delete from scan_reports
        where subject_type = 'skill_version'
          and subject_id in (select id::text from skill_versions where skill_id = $1)`,
      [skill.id],
    );
    //  - install tokens scoped to this skill (also covered by the skill_id FK cascade; explicit
    //    here so the cleanup is obvious and order-independent)
    await client.query(`delete from tokens where skill_id = $1`, [skill.id]);

    // The skill itself — cascades to versions/ratings/watches/categories/maintainers/usage/mirrors.
    await client.query(`delete from skills where id = $1`, [skill.id]);

    await appendAudit(client, {
      actorUserId: input.actorUserId,
      action: "skill.deleted",
      targetType: "skill",
      targetId: skill.id,
      namespaceId: skill.namespaceId,
      before: { namespaceSlug: input.namespaceSlug, skillSlug: input.skillSlug, visibility: skill.visibility },
    });

    await client.query("commit");
    return { ok: true };
  } catch (e) {
    await client.query("rollback");
    return { ok: false, status: 500, error: (e as Error).message };
  } finally {
    client.release();
  }
}
