// Moving a skill to another namespace (SKILLY_SPEC.md §70) — the DB side: the destination lookup,
// the slug-conflict check, the move itself (owner switch, aliases, grant clean-up, re-routing the
// skill's other open proposals, audit), the `skill.moved` fan-out, and the alias resolution every
// `<ns>/<slug>` surface falls back to (§70.6). The proposal lifecycle that decides WHEN a move
// happens lives in proposals.ts; the pure rules in @skilly/shared/namespace-move.
import type { Pool, PoolClient } from "pg";
import {
  destinationError,
  isSkillVisible,
  lockSlugForCreate,
  sharedNamespaceIdsSql,
  userCanSeeSkillSql,
  type EffectiveAccess,
} from "@skilly/shared";
import { pool as defaultPool } from "./db";
import { appendAudit } from "./audit";
import { pruneIneligibleMaintainers } from "./maintainers";

type Db = Pool | PoolClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The open proposal states — the ones a move re-routes (§70.7 step 6). */
export const OPEN_PROPOSAL_STATES = ["proposed", "under_review", "changes_requested", "awaiting_destination"] as const;

export interface NamespaceRef {
  id: string;
  slug: string;
  displayName: string;
  requireReview: boolean;
}

/** A namespace by id, or null (unknown / not a uuid). */
export async function loadNamespaceById(db: Db, id: string | null | undefined): Promise<NamespaceRef | null> {
  if (!id || !UUID.test(id)) return null;
  const { rows } = await db.query<{ id: string; slug: string; display_name: string; require_review: boolean }>(
    `select id, slug, display_name, require_review from namespaces where id = $1`,
    [id],
  );
  const r = rows[0];
  return r ? { id: r.id, slug: r.slug, displayName: r.display_name, requireReview: r.require_review } : null;
}

/**
 * The destination a submission names, validated (§70.1/§70.2): `{ ok: true, destination: null }` for
 * no move, the namespace for a move, or the refusal text. `ownerNamespaceId` is the skill's current
 * owner; picking it again is no move. A `global` skill never moves.
 */
export async function validateDestination(
  db: Db,
  input: { destinationNamespaceId: string | null | undefined; ownerNamespaceId: string; ownerNamespaceSlug: string },
): Promise<{ ok: true; destination: NamespaceRef | null } | { ok: false; error: string }> {
  const raw = typeof input.destinationNamespaceId === "string" ? input.destinationNamespaceId.trim() : "";
  if (!raw || raw === input.ownerNamespaceId) return { ok: true, destination: null };
  if (input.ownerNamespaceSlug === "global") return { ok: false, error: "a global skill can't move to another namespace" };
  const dest = await loadNamespaceById(db, raw);
  const err = destinationError(dest);
  if (err) return { ok: false, error: err };
  return { ok: true, destination: dest! };
}

/** What already holds the skill's slug at the destination (§70.2), or null when it is free. */
export type DestinationConflict =
  | {
      kind: "skill";
      skillId: string;
      namespaceSlug: string;
      slug: string;
      /** Whether the READER (the `access` passed in) can see that skill — only then is it named. */
      visible: boolean;
    }
  | { kind: "alias" };

export async function destinationConflict(
  db: Db,
  access: EffectiveAccess | null,
  input: { skillId: string; slug: string; destinationNamespaceId: string },
): Promise<DestinationConflict | null> {
  const { rows } = await db.query<{
    id: string; namespace_id: string; ns_slug: string; slug: string; visibility: "org" | "namespace"; shared_namespace_ids: string[];
  }>(
    `select s.id, s.namespace_id, n.slug as ns_slug, s.slug, s.visibility, ${sharedNamespaceIdsSql("s")} as shared_namespace_ids
       from skills s join namespaces n on n.id = s.namespace_id
      where s.namespace_id = $1 and lower(s.slug) = lower($2) and s.id <> $3
      limit 1`,
    [input.destinationNamespaceId, input.slug, input.skillId],
  );
  const live = rows[0];
  if (live) {
    const visible = access
      ? isSkillVisible(access, { namespaceId: live.namespace_id, visibility: live.visibility, sharedNamespaceIds: live.shared_namespace_ids ?? [] })
      : false;
    return { kind: "skill", skillId: live.id, namespaceSlug: live.ns_slug, slug: live.slug, visible };
  }
  const alias = await db.query(
    `select 1 from skill_path_aliases where namespace_id = $1 and slug = lower($2) and skill_id <> $3`,
    [input.destinationNamespaceId, input.slug, input.skillId],
  );
  return (alias.rowCount ?? 0) > 0 ? { kind: "alias" } : null;
}

/** §70.6: is `<namespace>/<slug>` reserved by an alias (a skill that moved out of it)? */
export async function isSlugReserved(db: Db, namespaceId: string, slug: string): Promise<boolean> {
  const { rowCount } = await db.query(`select 1 from skill_path_aliases where namespace_id = $1 and slug = lower($2)`, [namespaceId, slug]);
  return (rowCount ?? 0) > 0;
}

export interface ReroutedProposal {
  id: string;
  state: string;
  submittedBy: string;
  semver: string;
}

export type MoveOutcome =
  | { ok: true; moved: false }
  | {
      ok: true;
      moved: true;
      skillId: string;
      slug: string;
      visibility: "org" | "namespace";
      from: { id: string; slug: string };
      to: { id: string; slug: string };
      rerouted: ReroutedProposal[];
    }
  | { ok: false; kind: "conflict"; conflict: DestinationConflict; destinationSlug: string }
  | { ok: false; kind: "invalid"; error: string };

/**
 * Move the skill to the destination (§70.7 steps 2, 4 and 6, plus the destination's grant row), in
 * the caller's transaction, BEFORE the version is materialized — so the materialize step syncs the
 * submitted grant list and auto-adds the maintainer against the NEW owner. Steps:
 *  - the per-slug lock, then the conflict re-check (a live skill or another skill's alias there);
 *  - drop this skill's own alias at the destination (a move back), switch `namespace_id`, record the
 *    old address as an alias;
 *  - drop the destination's grant row (an owner is never its own grantee), audited;
 *  - re-route the skill's other open proposals to the new owner (assignee cleared; the 0112 turn
 *    trigger starts a fresh turn); a destination equal to the new owner is cleared from the mirror
 *    column — its revision still names the old source, so its next accept fails `skill_moved`.
 * The caller audits `skill.moved` (it knows the version) and notifies after the grant sync.
 */
export async function applySkillMove(
  client: PoolClient,
  input: { skillId: string; destinationNamespaceId: string; actorUserId: string | null; via: "proposal_accept" | "direct_publish"; proposalId: string | null },
): Promise<MoveOutcome> {
  const { rows } = await client.query<{ id: string; slug: string; namespace_id: string; ns_slug: string; visibility: "org" | "namespace" }>(
    `select s.id, s.slug, s.namespace_id, n.slug as ns_slug, s.visibility
       from skills s join namespaces n on n.id = s.namespace_id
      where s.id = $1 for update of s`,
    [input.skillId],
  );
  const s = rows[0];
  if (!s) return { ok: false, kind: "invalid", error: "skill not found" };
  if (s.namespace_id === input.destinationNamespaceId) return { ok: true, moved: false };
  const v = await validateDestination(client, { destinationNamespaceId: input.destinationNamespaceId, ownerNamespaceId: s.namespace_id, ownerNamespaceSlug: s.ns_slug });
  if (!v.ok) return { ok: false, kind: "invalid", error: v.error };
  const dest = v.destination!;

  // Serialize with any creation of this slug (the §8 per-slug lock), then re-check the address.
  await lockSlugForCreate(client, s.slug);
  const conflict = await destinationConflict(client, null, { skillId: s.id, slug: s.slug, destinationNamespaceId: dest.id });
  if (conflict) return { ok: false, kind: "conflict", conflict, destinationSlug: dest.slug };

  await client.query(`delete from skill_path_aliases where namespace_id = $1 and slug = $2 and skill_id = $3`, [dest.id, s.slug, s.id]);
  await client.query(`update skills set namespace_id = $2 where id = $1`, [s.id, dest.id]);
  await client.query(`insert into skill_path_aliases (namespace_id, slug, skill_id) values ($1, $2, $3)`, [s.namespace_id, s.slug, s.id]);

  const { rowCount: unshared } = await client.query(
    `delete from skill_namespace_grants where skill_id = $1 and namespace_id = $2`,
    [s.id, dest.id],
  );
  if (unshared) {
    await appendAudit(client, {
      actorUserId: input.actorUserId,
      action: "skill.namespace_unshared",
      targetType: "skill",
      targetId: s.id,
      namespaceId: dest.id,
      before: { namespaceId: dest.id },
      after: { via: input.via, reason: "became_owner" },
    });
  }

  const { rows: rerouted } = await client.query<{ id: string; state: string; submitted_by: string; proposed_semver: string }>(
    `update proposals
        set target_namespace_id = $2,
            destination_namespace_id = case when destination_namespace_id = $2 then null else destination_namespace_id end,
            assignment_changed_at = case when assignee_id is not null then now() else assignment_changed_at end,
            assignee_id = null,
            assigned_by = null,
            updated_at = now()
      where target_skill_id = $1
        and ($3::uuid is null or id <> $3::uuid)
        and state = any($4::proposal_state[])
      returning id, state, submitted_by, proposed_semver`,
    [s.id, dest.id, input.proposalId, [...OPEN_PROPOSAL_STATES]],
  );

  return {
    ok: true,
    moved: true,
    skillId: s.id,
    slug: s.slug,
    visibility: s.visibility,
    from: { id: s.namespace_id, slug: s.ns_slug },
    to: { id: dest.id, slug: dest.slug },
    rerouted: rerouted.map((r) => ({ id: r.id, state: r.state, submittedBy: r.submitted_by, semver: r.proposed_semver })),
  };
}

/**
 * After the grant sync (materialize): prune explicit maintainers who can no longer see the skill
 * (§70.4, the §42.4 rule) and audit `skill.moved` (§70.10).
 */
export async function finishSkillMove(
  client: PoolClient,
  move: Extract<MoveOutcome, { moved: true }>,
  input: { actorUserId: string | null; via: "proposal_accept" | "direct_publish"; proposalId: string | null; semver: string },
): Promise<void> {
  await pruneIneligibleMaintainers(client, { id: move.skillId, namespaceId: move.to.id, visibility: move.visibility }, input.actorUserId, input.via);
  await appendAudit(client, {
    actorUserId: input.actorUserId,
    action: "skill.moved",
    targetType: "skill",
    targetId: move.skillId,
    namespaceId: move.to.id,
    before: { namespaceId: move.from.id, namespaceSlug: move.from.slug, slug: move.slug },
    after: {
      namespaceId: move.to.id,
      namespaceSlug: move.to.slug,
      slug: move.slug,
      proposalId: input.proposalId,
      via: input.via,
      semver: input.semver,
      reroutedProposalIds: move.rerouted.map((r) => r.id),
    },
  });
}

/**
 * `skill.moved` (§70.9): the admins of the old and the new owner ∪ watchers ∪ explicit maintainers ∪
 * current installers (the §45.6 definition), minus the actor, one row per recipient, filtered at
 * insert against who can see the skill AFTER the move (run after the grant sync). The payload names
 * the version, so the worker's new-version fan-out skips these recipients (one row per accept).
 */
export async function notifySkillMoved(
  client: PoolClient,
  input: { skillId: string; oldNamespaceId: string; oldNamespaceSlug: string; semver: string; actorUserId: string | null },
): Promise<number> {
  const { rowCount } = await client.query(
    `with meta as (
       select s.id, s.slug as skill_slug, s.title as skill_title, n.slug as ns_slug,
              case
                when s.visibility = 'org' then
                  case when exists (select 1 from platform_settings ps where ps.key = 'marketplace_public_enabled' and ps.value = 'true'::jsonb)
                       then n.slug || '-' || s.slug end
                else case when n.marketplace_enabled then s.slug end
              end as marketplace_name
         from skills s join namespaces n on n.id = s.namespace_id
        where s.id = $1
     ), candidates as (
       select gm.user_id
         from role_mappings rm
         join group_memberships gm on gm.group_id = rm.group_id
        where rm.role = 'namespace_admin'
          and (rm.namespace_id = $2::uuid or rm.namespace_id = (select s.namespace_id from skills s where s.id = $1))
       union
       select w.user_id from skill_watches w where w.skill_id = $1
       union
       select sm.user_id from skill_maintainers sm where sm.skill_id = $1
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
        where ($5::uuid is null or u.id <> $5::uuid)
          and exists (select 1 from skills s where s.id = $1 and ${userCanSeeSkillSql("u.id", "s")})
     )
     insert into notifications (user_id, type, payload)
     select r.id, 'skill.moved',
            jsonb_build_object(
              'skillId', m.id::text, 'skillSlug', m.skill_slug, 'skillTitle', m.skill_title,
              'namespaceSlug', m.ns_slug, 'oldNamespaceSlug', $3::text, 'semver', $4::text,
              'marketplaceName', m.marketplace_name)
       from recipients r cross join meta m`,
    [input.skillId, input.oldNamespaceId, input.oldNamespaceSlug, input.semver, input.actorUserId],
  );
  return rowCount ?? 0;
}

// ── §70.6 alias resolution ──────────────────────────────────────────────────────────────────────

export interface CanonicalSkillAddress {
  skillId: string;
  namespaceSlug: string;
  slug: string;
}

/**
 * The canonical address behind an ALIAS `<ns>/<slug>`, or null when no alias sits there. A live
 * skill and an alias never share an address (migration 0112's triggers), so a hit means the address
 * is an old one. NO visibility check here — callers re-resolve through their own visibility-checked
 * lookups (the uniform 404 for an invisible skill, invariant #3), or check it themselves.
 */
export async function resolveSkillAlias(namespaceSlug: string, skillSlug: string, db: Db = defaultPool): Promise<CanonicalSkillAddress | null> {
  if (!namespaceSlug || !skillSlug) return null;
  const { rows } = await db.query<{ id: string; ns_slug: string; slug: string }>(
    `select s.id, n2.slug as ns_slug, s.slug
       from skill_path_aliases a
       join namespaces n on n.id = a.namespace_id
       join skills s on s.id = a.skill_id
       join namespaces n2 on n2.id = s.namespace_id
      where n.slug = lower($1) and a.slug = lower($2)`,
    [namespaceSlug, skillSlug],
  );
  const r = rows[0];
  return r ? { skillId: r.id, namespaceSlug: r.ns_slug, slug: r.slug } : null;
}

/**
 * Skill-addressed API routes (`/api/skills/:ns/:slug/…`, §70.6): the route params with an old
 * address replaced by the canonical one, so the handler serves the skill as if it had been
 * addressed canonically — its own visibility check still decides (an invisible skill stays a 404).
 * A lookup failure leaves the params untouched (the route then answers as before).
 */
export function canonicalSkillParams<T extends { ns: string; slug: string }>(params: Promise<T>): Promise<T> {
  // Memoized per request (the params promise is one object per request), so a handler that reads
  // `ctx.params` more than once pays for one lookup.
  const hit = canonicalCache.get(params);
  if (hit) return hit as Promise<T>;
  const out = (async () => {
    const p = await params;
    try {
      const a = await resolveSkillAlias(p.ns, p.slug);
      return a ? { ...p, ns: a.namespaceSlug, slug: a.slug } : p;
    } catch {
      return p;
    }
  })();
  canonicalCache.set(params, out);
  return out;
}
const canonicalCache = new WeakMap<object, Promise<unknown>>();
