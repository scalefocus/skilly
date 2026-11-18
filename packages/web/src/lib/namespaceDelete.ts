// Deleting a namespace (SKILLY_SPEC.md §71). A platform admin deletes an EMPTY namespace — no live
// skill, no open proposal against it (§71.2) — and everything else it holds is removed or re-homed in
// one transaction (§71.3). Each step reuses the existing path for its object so its own audit events
// stay identical: the §7 permanent delete for archived skills, the §8 housekeeping delete for
// proposals, the §42 grants module for incoming shares, the §30.6 token revocation for the
// marketplace. The worker clears the disk afterwards (§71.4, packages/worker/src/git/namespacePurge.ts).
import type { Pool, PoolClient } from "pg";
import {
  deleteRequestError,
  normalizeDeleteReason,
  rehomedDestination,
  NAMESPACE_DELETE_LIST_LIMIT,
  NAMESPACE_DELETE_MESSAGES,
  NAMESPACE_NOT_EMPTY_CODE,
  OPEN_PROPOSAL_STATES,
  type NamespaceDeleteEffects,
} from "@skilly/shared";
import { appendAudit } from "./audit";
import { invalidateAccessCaches } from "./access";
import { removeGrant } from "./grants";
import { purgeSkillInTx } from "./manage";
import { purgeProposalInTx } from "./proposals";
import { revokeNamespaceMarketplaceTokens } from "./marketplaces";

type Db = Pool | PoolClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface NamespaceRow {
  id: string;
  slug: string;
  display_name: string;
  require_review: boolean;
  maintainer_contact: string | null;
  marketplace_enabled: boolean;
  review_target_days: number | null;
  created_at: string;
}

export interface DeletionBlockers {
  skills: { slug: string; title: string; deprecated: boolean }[];
  skillsTotal: number;
  proposals: { id: string; title: string; state: string }[];
  proposalsTotal: number;
}

export interface DeletionEffectsView extends NamespaceDeleteEffects {
  /** The archived skills that will be purged, slug-ordered (capped like the blocker lists). */
  archivedSkills: string[];
  roleMappings: { groupDisplayName: string; role: string }[];
}

export interface DeletionPreflight {
  namespace: { id: string; slug: string; displayName: string };
  deletable: boolean;
  blockers: DeletionBlockers;
  effects: DeletionEffectsView;
}

export type NamespaceDeleteResult =
  | { ok: true; effects: NamespaceDeleteEffects }
  | { ok: false; status: number; error: string; code?: string; blockers?: DeletionBlockers };

async function loadNamespace(db: Db, id: string, forUpdate = false): Promise<NamespaceRow | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await db.query<NamespaceRow>(
    `select id, slug, display_name, require_review, maintainer_contact, marketplace_enabled, review_target_days, created_at
       from namespaces where id = $1${forUpdate ? " for update" : ""}`,
    [id],
  );
  return rows[0] ?? null;
}

/** §71.2: the live skills and open proposals that keep the namespace from being deleted. */
export async function deletionBlockers(db: Db, namespaceId: string): Promise<DeletionBlockers> {
  const [skills, proposals] = await Promise.all([
    db.query<{ slug: string; title: string; deprecated: boolean; total: string }>(
      `select slug, title, deprecated_at is not null as deprecated, count(*) over ()::text as total
         from skills
        where namespace_id = $1 and status <> 'archived'
        order by slug
        limit $2`,
      [namespaceId, NAMESPACE_DELETE_LIST_LIMIT],
    ),
    db.query<{ id: string; title: string | null; state: string; total: string }>(
      `select p.id, p.state::text as state,
              coalesce(s.title, lr.payload->'metadata'->>'title', lr.payload->'metadata'->>'skillSlug') as title,
              count(*) over ()::text as total
         from proposals p
         left join skills s on s.id = p.target_skill_id
         left join lateral (
           select payload from proposal_revisions where proposal_id = p.id order by revision_no desc limit 1
         ) lr on true
        where (p.target_namespace_id = $1 and p.state::text = any($2::text[]))
           or (p.state = 'awaiting_destination' and p.destination_namespace_id = $1)
        order by p.created_at
        limit $3`,
      [namespaceId, [...OPEN_PROPOSAL_STATES], NAMESPACE_DELETE_LIST_LIMIT],
    ),
  ]);
  return {
    skills: skills.rows.map((r) => ({ slug: r.slug, title: r.title, deprecated: r.deprecated })),
    skillsTotal: Number(skills.rows[0]?.total ?? 0),
    proposals: proposals.rows.map((r) => ({ id: r.id, title: r.title ?? "Untitled proposal", state: r.state })),
    proposalsTotal: Number(proposals.rows[0]?.total ?? 0),
  };
}

interface ClosedProposalRow {
  id: string;
  state: string;
  target_namespace_id: string;
  proposed_semver: string;
  submitted_by: string;
  destination_namespace_id: string | null;
  tie_namespace_id: string | null;
}

/**
 * The namespace's closed proposals with the namespace that owns their skill NOW. A proposal is tied
 * to its skill by `target_skill_id`, through `materialized_version_id`, or — for an accepted
 * new-skill pointer proposal, which records neither — through the old-address alias of its slug
 * (a skill that moved out). §71.3 steps 4–5.
 */
async function closedProposals(db: Db, namespaceId: string): Promise<ClosedProposalRow[]> {
  const { rows } = await db.query<ClosedProposalRow>(
    `select p.id, p.state::text as state, p.target_namespace_id, p.proposed_semver, p.submitted_by,
            p.destination_namespace_id, t.namespace_id as tie_namespace_id
       from proposals p
       left join lateral (
         select s.namespace_id from skills s
          where s.id = coalesce(
                  p.target_skill_id,
                  (select sv.skill_id from skill_versions sv where sv.id = p.materialized_version_id),
                  (select a.skill_id from skill_path_aliases a
                    where a.namespace_id = p.target_namespace_id
                      and a.slug = (select r.payload->'metadata'->>'skillSlug' from proposal_revisions r
                                     where r.proposal_id = p.id order by r.revision_no desc limit 1)))
       ) t on true
      where p.target_namespace_id = $1 and p.state in ('accepted', 'rejected')
      order by p.created_at`,
    [namespaceId],
  );
  return rows;
}

/** Active users who administer the namespace through a role mapping, minus the actor (§71.6). */
async function namespaceAdminIds(db: Db, namespaceId: string, actorUserId: string | null): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select distinct u.id
       from role_mappings rm
       join group_memberships gm on gm.group_id = rm.group_id
       join users u on u.id = gm.user_id
      where rm.role = 'namespace_admin' and rm.namespace_id = $1 and u.status = 'active'
        and ($2::uuid is null or u.id <> $2::uuid)`,
    [namespaceId, actorUserId],
  );
  return rows.map((r) => r.id);
}

async function countOf(db: Db, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/** What a delete would do right now (§71.5 Ready state, §71.9 `effects`). */
async function deletionEffects(db: Db, ns: NamespaceRow, actorUserId: string | null): Promise<DeletionEffectsView> {
  const [archived, closed, usage, aliases, grants, tokens, rules, mappings, imports, admins] = await Promise.all([
    db.query<{ slug: string; total: string }>(
      `select slug, count(*) over ()::text as total from skills where namespace_id = $1 and status = 'archived' order by slug limit $2`,
      [ns.id, NAMESPACE_DELETE_LIST_LIMIT],
    ),
    closedProposals(db, ns.id),
    countOf(db, `select count(*)::text as n from usage_events u join skills s on s.id = u.skill_id where u.namespace_id = $1 and s.namespace_id <> $1`, [ns.id]),
    countOf(db, `select count(*)::text as n from skill_path_aliases where namespace_id = $1`, [ns.id]),
    countOf(db, `select count(*)::text as n from skill_namespace_grants where namespace_id = $1`, [ns.id]),
    countOf(db, `select count(*)::text as n from tokens where type = 'marketplace' and namespace_id = $1`, [ns.id]),
    countOf(db, `select count(*)::text as n from policy_rules where namespace_id = $1`, [ns.id]),
    db.query<{ group_display_name: string; role: string }>(
      `select g.display_name as group_display_name, rm.role::text as role
         from role_mappings rm join groups g on g.id = rm.group_id
        where rm.namespace_id = $1
        order by lower(g.display_name), rm.role`,
      [ns.id],
    ),
    countOf(db, `select count(*)::text as n from proposal_imports where target_namespace_id = $1`, [ns.id]),
    namespaceAdminIds(db, ns.id, actorUserId),
  ]);
  // Closed proposals tied to an archived skill of this namespace go with that skill's purge, so
  // they are neither re-homed nor counted as deleted here.
  const rehomed = closed.filter((p) => p.tie_namespace_id && p.tie_namespace_id !== ns.id).length;
  const deleted = closed.filter((p) => !p.tie_namespace_id).length;
  return {
    archivedSkillsPurged: Number(archived.rows[0]?.total ?? 0),
    archivedSkills: archived.rows.map((r) => r.slug),
    proposalsRehomed: rehomed,
    proposalsDeleted: deleted,
    usageRowsRehomed: usage,
    aliasesDropped: aliases,
    grantsRevoked: grants,
    marketplaceEnabled: ns.marketplace_enabled,
    // Only the §30.6 disable revokes them, and it runs only for an enabled marketplace (step 8).
    marketplaceTokensRevoked: ns.marketplace_enabled ? tokens : 0,
    policyRulesDeleted: rules,
    roleMappingsRemoved: mappings.rows.length,
    roleMappings: mappings.rows.map((r) => ({ groupDisplayName: r.group_display_name, role: r.role })),
    importsRemoved: imports,
    adminsNotified: admins.length,
  };
}

/** GET /api/admin/namespaces/:id/deletion — the preflight the dialog opens with (§71.5, §71.9). */
export async function namespaceDeletionPreflight(
  db: Pool,
  namespaceId: string,
  actorUserId: string | null,
): Promise<{ ok: true; preflight: DeletionPreflight } | { ok: false; status: number; error: string; code?: string }> {
  const ns = await loadNamespace(db, namespaceId);
  if (!ns) return { ok: false, status: 404, error: "namespace not found" };
  if (ns.slug === "global") return { ok: false, status: 422, error: NAMESPACE_DELETE_MESSAGES.global_namespace!, code: "global_namespace" };
  const [blockers, effects] = await Promise.all([deletionBlockers(db, ns.id), deletionEffects(db, ns, actorUserId)]);
  return {
    ok: true,
    preflight: {
      namespace: { id: ns.id, slug: ns.slug, displayName: ns.display_name },
      deletable: blockers.skillsTotal === 0 && blockers.proposalsTotal === 0,
      blockers,
      effects,
    },
  };
}

/**
 * DELETE /api/admin/namespaces/:id — §71.3, one transaction under a FOR UPDATE lock on the namespace
 * row. The caller has checked that the actor is a platform admin. Notifications go out after commit.
 */
export async function deleteNamespace(
  pool: Pool,
  namespaceId: string,
  input: { confirmSlug: unknown; reason: unknown },
  actorUserId: string,
): Promise<NamespaceDeleteResult> {
  const pre = await loadNamespace(pool, namespaceId);
  if (!pre) return { ok: false, status: 404, error: "namespace not found" };
  const requestError = deleteRequestError({ slug: pre.slug, confirmSlug: input.confirmSlug, reason: input.reason });
  if (requestError) return { ok: false, status: 422, error: NAMESPACE_DELETE_MESSAGES[requestError]!, code: requestError };
  const reason = normalizeDeleteReason(input.reason);

  const client = await pool.connect();
  let recipients: string[] = [];
  let ns: NamespaceRow | null = null;
  let effects: NamespaceDeleteEffects;
  try {
    await client.query("begin");
    // Step 1: lock the row, then re-check the blockers under the lock. A concurrent skill insert,
    // proposal, move or grant into the namespace waits on this lock (its FK check) and fails once
    // the row is gone.
    ns = await loadNamespace(client, namespaceId, true);
    if (!ns) {
      await client.query("rollback");
      return { ok: false, status: 404, error: "namespace not found" };
    }
    const blockers = await deletionBlockers(client, ns.id);
    if (blockers.skillsTotal > 0 || blockers.proposalsTotal > 0) {
      await client.query("rollback");
      return { ok: false, status: 409, error: NAMESPACE_DELETE_MESSAGES[NAMESPACE_NOT_EMPTY_CODE]!, code: NAMESPACE_NOT_EMPTY_CODE, blockers };
    }

    // Step 2: the notification recipients, while the role mappings still exist.
    recipients = await namespaceAdminIds(client, ns.id, actorUserId);

    // Step 3: purge the archived skills through the §7 permanent-delete path.
    const { rows: archived } = await client.query<{ id: string; slug: string; visibility: string }>(
      `select id, slug, visibility::text as visibility from skills where namespace_id = $1 and status = 'archived' order by slug`,
      [ns.id],
    );
    for (const s of archived) {
      await purgeSkillInTx(client, { id: s.id, namespaceId: ns.id, visibility: s.visibility }, { actorUserId, namespaceSlug: ns.slug, skillSlug: s.slug });
    }

    // Steps 4–5: re-home the closed proposals of skills that moved out; delete the ones tied to no
    // surviving skill. (Those tied to the archived skills went with step 3.) Must run before the
    // aliases go (step 6) — an accepted pointer proposal is tied to its moved skill through one.
    const closed = await closedProposals(client, ns.id);
    const rehomedIds: string[] = [];
    let proposalsDeleted = 0;
    for (const p of closed) {
      if (p.tie_namespace_id && p.tie_namespace_id !== ns.id) {
        await client.query(
          `update proposals set target_namespace_id = $2, destination_namespace_id = $3 where id = $1`,
          [p.id, p.tie_namespace_id, rehomedDestination(p.destination_namespace_id, p.tie_namespace_id)],
        );
        rehomedIds.push(p.id);
      } else if (!p.tie_namespace_id) {
        await purgeProposalInTx(client, p, actorUserId);
        proposalsDeleted++;
      }
    }
    const usage = await client.query(
      `update usage_events u set namespace_id = s.namespace_id
         from skills s
        where u.namespace_id = $1 and s.id = u.skill_id and s.namespace_id <> $1`,
      [ns.id],
    );

    // Step 6: drop the old addresses, remembering them for the worker's relocation (§71.4).
    const { rows: aliases } = await client.query<{ slug: string; skill_id: string }>(
      `delete from skill_path_aliases where namespace_id = $1 returning slug, skill_id`,
      [ns.id],
    );

    // Step 7: revoke the shares into the namespace through the grants module (no notifications).
    const { rows: grants } = await client.query<{ skill_id: string; namespace_id: string; visibility: "org" | "namespace" }>(
      `select g.skill_id, s.namespace_id, s.visibility::text as visibility
         from skill_namespace_grants g join skills s on s.id = g.skill_id
        where g.namespace_id = $1
        order by g.skill_id`,
      [ns.id],
    );
    let grantsRevoked = 0;
    for (const g of grants) {
      const out = await removeGrant(client, { id: g.skill_id, namespaceId: g.namespace_id, visibility: g.visibility }, ns.id, actorUserId, "namespace_deleted");
      if (out.removed) grantsRevoked++;
    }

    // Step 8: turn the marketplace off — the §30.6 disable: revoke its tokens, audit the count.
    let marketplaceTokensRevoked = 0;
    if (ns.marketplace_enabled) {
      await client.query(`update namespaces set marketplace_enabled = false, marketplace_synced_at = null where id = $1`, [ns.id]);
      marketplaceTokensRevoked = await revokeNamespaceMarketplaceTokens(ns.id, client);
      await appendAudit(client, {
        actorUserId,
        action: "namespace.marketplace_disabled",
        targetType: "namespace",
        targetId: ns.slug,
        namespaceId: ns.id,
        before: { marketplaceEnabled: true },
        after: { marketplaceEnabled: false, tokensRevoked: marketplaceTokensRevoked, via: "namespace_deleted" },
      });
    }

    // Step 9: the namespace policy rules, with every citation of them (§47.1 decision 4's one
    // exception). Results and dismissals hold RESTRICT keys on the rule and its revisions.
    const { rows: rules } = await client.query<{ id: string; state: string; title: string | null }>(
      `select r.id, r.state, (select v.title from policy_rule_revisions v where v.rule_id = r.id order by v.revision_no desc limit 1) as title
         from policy_rules r where r.namespace_id = $1 order by r.created_at`,
      [ns.id],
    );
    for (const r of rules) {
      const results = await client.query(`delete from ai_prereview_policy_results where rule_id = $1`, [r.id]);
      const dismissals = await client.query(`delete from policy_flag_dismissals where rule_id = $1`, [r.id]);
      await client.query(`delete from policy_rules where id = $1`, [r.id]);
      await appendAudit(client, {
        actorUserId,
        action: "policy.rule_deleted",
        targetType: "policy_rule",
        targetId: r.id,
        namespaceId: ns.id,
        before: { scope: "namespace", state: r.state, title: r.title },
        after: { via: "namespace_deleted", resultsRemoved: results.rowCount ?? 0, dismissalsRemoved: dismissals.rowCount ?? 0 },
      });
    }

    // Step 10: the role mappings (the Entra groups and memberships are SCIM's and stay).
    const { rows: mappings } = await client.query<{ id: string; group_id: string; group_display_name: string; role: string }>(
      `select rm.id, rm.group_id, g.display_name as group_display_name, rm.role::text as role
         from role_mappings rm join groups g on g.id = rm.group_id
        where rm.namespace_id = $1
        order by lower(g.display_name), rm.role`,
      [ns.id],
    );
    for (const m of mappings) {
      await client.query(`delete from role_mappings where id = $1`, [m.id]);
      await appendAudit(client, {
        actorUserId,
        action: "role_mapping.deleted",
        targetType: "role_mapping",
        targetId: m.id,
        before: { group_id: m.group_id, namespace_id: ns.id, role: m.role },
        after: { via: "namespace_deleted" },
      });
    }

    // Step 11: the repository imports that targeted the namespace (proposals keep, link → NULL).
    const imports = await client.query(`delete from proposal_imports where target_namespace_id = $1`, [ns.id]);

    // Step 12: queue the disk purge; the slug is reusable only once the worker has run it.
    await client.query(
      `insert into repo_disk_purges (namespace_slug, namespace_id, relocations)
       values ($1, $2, $3::jsonb)
       on conflict (namespace_slug) do update
         set namespace_id = excluded.namespace_id,
             relocations = repo_disk_purges.relocations || excluded.relocations`,
      [ns.slug, ns.id, JSON.stringify(aliases.map((a) => ({ slug: a.slug, skillId: a.skill_id })))],
    );

    // Step 13: the row. The remaining FK cascades find nothing left; they stay as defence in depth.
    await client.query(`delete from namespaces where id = $1`, [ns.id]);

    effects = {
      archivedSkillsPurged: archived.length,
      proposalsRehomed: rehomedIds.length,
      proposalsDeleted,
      usageRowsRehomed: usage.rowCount ?? 0,
      aliasesDropped: aliases.length,
      grantsRevoked,
      marketplaceEnabled: ns.marketplace_enabled,
      marketplaceTokensRevoked,
      policyRulesDeleted: rules.length,
      roleMappingsRemoved: mappings.length,
      importsRemoved: imports.rowCount ?? 0,
      adminsNotified: recipients.length,
    };

    // Step 14: the deletion record — the full row before, the reason and the counts after.
    await appendAudit(client, {
      actorUserId,
      action: "namespace.deleted",
      targetType: "namespace",
      targetId: ns.id,
      namespaceId: ns.id,
      before: {
        slug: ns.slug,
        displayName: ns.display_name,
        requireReview: ns.require_review,
        maintainerContact: ns.maintainer_contact,
        marketplaceEnabled: ns.marketplace_enabled,
        reviewTargetDays: ns.review_target_days,
        createdAt: ns.created_at,
        roleMappings: mappings.map((m) => ({ groupId: m.group_id, groupDisplayName: m.group_display_name, role: m.role })),
      },
      after: { reason, ...effects, rehomedProposalIds: rehomedIds },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  invalidateAccessCaches(); // the removed role mappings stop granting access on the next request

  // Step 15: notify the namespace's admins. The delete has committed; a failure here is logged, not
  // reported as a failed delete.
  if (recipients.length) {
    try {
      await pool.query(
        `insert into notifications (user_id, type, payload)
         select unnest($1::uuid[]), 'namespace.deleted',
                jsonb_build_object('namespaceSlug', $2::text, 'displayName', $3::text, 'reason', $4::text,
                                   'actorName', (select coalesce(nullif(u.display_name, ''), u.email) from users u where u.id = $5::uuid))`,
        [recipients, ns.slug, ns.display_name, reason, actorUserId],
      );
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "namespace.deleted notifications failed", namespace: ns.slug, err: String(err) }));
    }
  }
  return { ok: true, effects };
}

/** §71.4: a slug whose deleted namespace still has files on disk can't be taken yet. */
export async function slugAwaitingPurge(db: Db, slug: string): Promise<boolean> {
  const { rowCount } = await db.query(`select 1 from repo_disk_purges where namespace_slug = $1`, [slug]);
  return (rowCount ?? 0) > 0;
}
