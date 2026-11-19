// Moving a NEW-SKILL proposal to another namespace (SKILLY_SPEC.md §74) — the DB side: the move
// targets a reviewer may pick, the slug check at the new namespace, and the in-transaction move
// itself (revision, re-target, thread clean-up, audit). The lifecycle wrapper (`moveProposal`) and
// Move & accept live in proposals.ts; the pure rules in @skilly/shared/namespace-move.
import type { Pool, PoolClient } from "pg";
import {
  canReviewNamespace,
  isSkillVisible,
  moveTargetIds,
  retargetedState,
  retargetNote,
  sharedNamespaceIdsSql,
  slugInTargetMessage,
  withRetargetGrants,
  INVALID_TARGET_NAMESPACE_CODE,
  NOT_A_NEW_SKILL_PROPOSAL_CODE,
  PROPOSAL_DECIDED_CODE,
  RETARGETABLE_STATES,
  SLUG_EXISTS_IN_DESTINATION_CODE,
  type EffectiveAccess,
  type ProposalState,
} from "@skilly/shared";
import { appendAudit } from "./audit";
import { resolveUserAccessById } from "./access";
import { getProposalsOpen } from "./settings";
import type { RevisionPayload } from "./proposals";

type Db = Pool | PoolClient;

/** One namespace the review page's Namespace field offers (§74.6, §74.11). */
export interface MoveTargetView {
  id: string;
  slug: string;
  displayName: string;
  /** The caller also reviews it — Move & accept is offered. */
  canReview: boolean;
  /** Why it can't be picked, at the caller's visibility (§74.5), or null. */
  blocked: null | "slug_exists" | "slug_reserved";
}

/** What already holds a slug in a namespace (§74.5), or null when it is free. */
export type TargetSlugConflict =
  | { kind: "skill"; visible: boolean; name: string }
  | { kind: "alias"; visible: boolean; name: string };

/**
 * §74.5: the skill will be created in `namespaceId`, so the slug must be free there — no skill with
 * it in any status (the unique key covers archived ones) and no alias of a skill that moved out
 * (§70.6). `visible` says whether the READER may see the skill that holds it; only then is it named.
 */
export async function targetSlugConflict(db: Db, access: EffectiveAccess, namespaceId: string, slug: string): Promise<TargetSlugConflict | null> {
  type Row = { namespace_id: string; ns_slug: string; slug: string; visibility: "org" | "namespace"; shared_namespace_ids: string[] };
  const seen = (r: Row) => isSkillVisible(access, { namespaceId: r.namespace_id, visibility: r.visibility, sharedNamespaceIds: r.shared_namespace_ids ?? [] });
  const live = (await db.query<Row>(
    `select s.namespace_id, n.slug as ns_slug, s.slug, s.visibility, ${sharedNamespaceIdsSql("s")} as shared_namespace_ids
       from skills s join namespaces n on n.id = s.namespace_id
      where s.namespace_id = $1 and lower(s.slug) = lower($2)
      limit 1`,
    [namespaceId, slug],
  )).rows[0];
  if (live) return { kind: "skill", visible: seen(live), name: `${live.ns_slug}/${live.slug}` };
  const alias = (await db.query<Row>(
    `select s.namespace_id, n.slug as ns_slug, s.slug, s.visibility, ${sharedNamespaceIdsSql("s")} as shared_namespace_ids
       from skill_path_aliases a join skills s on s.id = a.skill_id join namespaces n on n.id = s.namespace_id
      where a.namespace_id = $1 and a.slug = lower($2)
      limit 1`,
    [namespaceId, slug],
  )).rows[0];
  return alias ? { kind: "alias", visible: seen(alias), name: `${alias.ns_slug}/${alias.slug}` } : null;
}

/** The 409 text for a slug conflict at the new namespace (§74.5). */
export function targetConflictMessage(targetSlug: string, slug: string, c: TargetSlugConflict): string {
  return slugInTargetMessage(targetSlug, slug, c.visible ? { name: c.name } : null, c.kind === "alias");
}

interface NamespaceRow { id: string; slug: string; display_name: string }

async function allNamespaces(db: Db): Promise<NamespaceRow[]> {
  return (await db.query<NamespaceRow>(`select id, slug, display_name from namespaces order by (slug = 'global') desc, slug asc`)).rows;
}

/** The facts a move needs from OUTSIDE its transaction (resolved first, so the transaction never
 *  holds a second pool connection while it sits on the proposal's row lock). */
export interface RetargetPrep {
  proposerAccess: EffectiveAccess | null;
  proposalsOpen: boolean;
  /** Everyone in the proposal's review thread, with their access — those who can't read the
   *  proposal after the move leave the thread (§74.7). */
  participants: { userId: string; access: EffectiveAccess }[];
}

export async function prepareRetarget(pool: Pool, proposalId: string): Promise<RetargetPrep | null> {
  const sub = (await pool.query<{ submitted_by: string }>(`select submitted_by from proposals where id = $1`, [proposalId])).rows[0];
  if (!sub) return null;
  const proposer = await resolveUserAccessById(sub.submitted_by);
  const { rows: parts } = await pool.query<{ user_id: string }>(
    `select cp.user_id from conversations c join conversation_participants cp on cp.conversation_id = c.id
      where c.subject_type = 'proposal' and c.subject_id = $1 and cp.user_id <> $2`,
    [proposalId, sub.submitted_by],
  );
  const participants: RetargetPrep["participants"] = [];
  for (const r of parts) participants.push({ userId: r.user_id, access: await resolveUserAccessById(r.user_id) });
  return {
    // An unknown or inactive proposer resolves to no roles: under members only, nothing qualifies.
    proposerAccess: proposer.userId ? proposer : null,
    proposalsOpen: await getProposalsOpen(pool),
    participants,
  };
}

/**
 * §74.11 `moveTargets`: the namespaces this reviewer may move the proposal to, each with whether
 * they review it too and why it is blocked. Empty unless the caller reviews the proposal's current
 * namespace and it is an open new-skill proposal (the CALLER checks the proposal kind and state).
 */
export async function listMoveTargets(
  db: Db,
  input: { access: EffectiveAccess; proposerAccess: EffectiveAccess | null; proposalsOpen: boolean; currentNamespaceId: string; slug: string },
): Promise<MoveTargetView[]> {
  if (!canReviewNamespace(input.access, input.currentNamespaceId)) return [];
  const namespaces = await allNamespaces(db);
  const ids = new Set(moveTargetIds({
    reviewer: input.access,
    proposer: input.proposerAccess,
    proposalsOpen: input.proposalsOpen,
    namespaces,
    currentNamespaceId: input.currentNamespaceId,
  }));
  // One pass over every same-slug skill and alias (not two queries per namespace). Only a holder
  // the caller can SEE blocks the option; anything else is refused at the move without a name.
  const blocked = new Map<string, MoveTargetView["blocked"]>();
  if (input.slug && ids.size > 0) {
    type Row = { at: string; namespace_id: string; visibility: "org" | "namespace"; shared_namespace_ids: string[]; alias: boolean };
    const { rows } = await db.query<Row>(
      `select s.namespace_id as at, s.namespace_id, s.visibility, ${sharedNamespaceIdsSql("s")} as shared_namespace_ids, false as alias
         from skills s where lower(s.slug) = lower($1)
       union all
       select a.namespace_id as at, s.namespace_id, s.visibility, ${sharedNamespaceIdsSql("s")} as shared_namespace_ids, true as alias
         from skill_path_aliases a join skills s on s.id = a.skill_id where a.slug = lower($1)`,
      [input.slug],
    );
    for (const r of rows) {
      if (!ids.has(r.at) || blocked.get(r.at) === "slug_exists") continue;
      if (!isSkillVisible(input.access, { namespaceId: r.namespace_id, visibility: r.visibility, sharedNamespaceIds: r.shared_namespace_ids ?? [] })) continue;
      blocked.set(r.at, r.alias ? "slug_reserved" : "slug_exists");
    }
  }
  return namespaces
    .filter((n) => ids.has(n.id))
    .map((n) => ({
      id: n.id,
      slug: n.slug,
      displayName: n.display_name,
      canReview: canReviewNamespace(input.access, n.id),
      blocked: blocked.get(n.id) ?? null,
    }));
}

/** The proposal fields the move reads (a row locked FOR UPDATE by the caller). */
export interface RetargetProposalRow {
  id: string;
  state: ProposalState;
  target_namespace_id: string;
  target_skill_id: string | null;
  submitted_by: string;
  proposed_semver: string;
}

export type RetargetOutcome =
  | {
      ok: true;
      from: { id: string; slug: string };
      to: { id: string; slug: string; displayName: string };
      revisionNo: number;
      state: ProposalState;
      skillSlug: string;
      /** Whether the actor can still read the proposal after the move. */
      canRead: boolean;
    }
  | { ok: false; status: 403 | 404 | 409 | 422; error: string; code?: string };

/**
 * §74.3 steps 1–3 inside the CALLER's transaction: the checks, the move revision, the re-target,
 * the thread clean-up and the `proposal.retargeted` audit row. `keepState` (Move & accept) leaves
 * the state alone, since the accept that follows decides it; a plain move resets a reviewer-turn
 * proposal to `proposed`. Notifications are the caller's (they differ between the two).
 */
export async function retargetInTx(
  client: PoolClient,
  input: {
    p: RetargetProposalRow;
    access: EffectiveAccess;
    actorUserId: string;
    targetNamespaceId: string;
    /** The reviewer's edited payload (verified by the route against the NEW namespace), or none. */
    newPayload?: RevisionPayload;
    note?: string | null;
    keepState: boolean;
    via: "move" | "move_accept";
    prep: RetargetPrep;
  },
): Promise<RetargetOutcome> {
  const { p, access } = input;
  if (!canReviewNamespace(access, p.target_namespace_id)) {
    return p.submitted_by === input.actorUserId
      ? { ok: false, status: 403, error: "only a reviewer of this proposal's namespace can move it" }
      : { ok: false, status: 404, error: "proposal not found" };
  }
  const latest = (await client.query<{ payload: RevisionPayload }>(
    `select payload from proposal_revisions where proposal_id = $1 order by revision_no desc limit 1`,
    [p.id],
  )).rows[0]?.payload;
  if (!latest) return { ok: false, status: 404, error: "proposal not found" };
  if (p.target_skill_id || latest.promotedFromSkillVersionId) {
    return { ok: false, status: 422, error: "only a new-skill proposal can move to another namespace — a new version moves its skill through the destination field", code: NOT_A_NEW_SKILL_PROPOSAL_CODE };
  }
  if (!RETARGETABLE_STATES.includes(p.state)) {
    return { ok: false, status: 409, error: `this proposal is ${p.state.replace(/_/g, " ")} — it can't move any more`, code: PROPOSAL_DECIDED_CODE };
  }

  const namespaces = await allNamespaces(client);
  const allowed = moveTargetIds({
    reviewer: access,
    proposer: input.prep.proposerAccess,
    proposalsOpen: input.prep.proposalsOpen,
    namespaces,
    currentNamespaceId: p.target_namespace_id,
  });
  const to = namespaces.find((n) => n.id === input.targetNamespaceId);
  const from = namespaces.find((n) => n.id === p.target_namespace_id)!;
  if (!to || !allowed.includes(to.id)) {
    const why = !to
      ? "that namespace doesn't exist"
      : to.id === p.target_namespace_id
        ? "the proposal is already in that namespace"
        : input.prep.proposalsOpen
          ? "you can move a proposal only to global or a namespace you belong to"
          : "proposals are limited to members, and the proposer can't propose into that namespace";
    return { ok: false, status: 422, error: why, code: INVALID_TARGET_NAMESPACE_CODE };
  }

  const payload: RevisionPayload = structuredClone(input.newPayload ?? latest);
  const skillSlug = payload.metadata.skillSlug;
  // §74.4: `global` holds only org-wide skills — the route's payload check refuses an edited payload,
  // this one covers a move that sent none.
  if (to.slug === "global" && payload.metadata.visibility === "namespace") {
    return { ok: false, status: 422, error: "a skill restricted to a namespace can’t live in the global namespace — set visibility to org-wide to move it there" };
  }
  const conflict = await targetSlugConflict(client, access, to.id, skillSlug);
  if (conflict) {
    return { ok: false, status: 409, error: targetConflictMessage(to.slug, skillSlug, conflict), code: SLUG_EXISTS_IN_DESTINATION_CODE };
  }
  // §74.4: the new owner is never its own grantee; with no edited payload the server applies the
  // default edit (the old namespace joins the list). An org skill has no list.
  if (payload.metadata.visibility === "namespace") {
    const cur = payload.metadata.sharedNamespaceIds ?? [];
    payload.metadata.sharedNamespaceIds = input.newPayload
      ? cur.filter((id) => id !== to.id)
      : withRetargetGrants(cur, from.id, to.id).sort();
  } else if (payload.metadata.sharedNamespaceIds !== undefined) {
    payload.metadata.sharedNamespaceIds = [];
  }

  const { rows: revIns } = await client.query<{ revision_no: number }>(
    `insert into proposal_revisions (proposal_id, revision_no, payload, author, note)
     select $1, coalesce(max(revision_no),0)+1, $2::jsonb, $3, $4 from proposal_revisions where proposal_id = $1
     returning revision_no`,
    [p.id, JSON.stringify(payload), input.actorUserId, retargetNote(from.slug, to.slug, input.note)],
  );
  const revisionNo = revIns[0]!.revision_no;
  const state = input.keepState ? p.state : retargetedState(p.state);
  // The turn trigger (migration 0112) starts a fresh turn on the new namespace's review target.
  await client.query(
    `update proposals
        set target_namespace_id = $2,
            state = $3,
            assignment_changed_at = case when assignee_id is not null then now() else assignment_changed_at end,
            assignee_id = null,
            assigned_by = null,
            updated_at = now()
      where id = $1`,
    [p.id, to.id, state],
  );

  // §74.7: thread participants who can't read the proposal from now on leave the thread, with
  // their unread alert for it — the submitter always stays.
  const losers = input.prep.participants
    .filter((x) => x.userId !== p.submitted_by && !canReviewNamespace(x.access, to.id))
    .map((x) => x.userId);
  if (losers.length > 0) {
    const conv = (await client.query<{ id: string }>(`select id from conversations where subject_type = 'proposal' and subject_id = $1`, [p.id])).rows[0];
    if (conv) {
      await client.query(`delete from conversation_participants where conversation_id = $1 and user_id = any($2::uuid[])`, [conv.id, losers]);
      await client.query(
        `delete from notifications where type = 'message.new' and read_at is null and user_id = any($1::uuid[]) and payload->>'conversationId' = $2`,
        [losers, conv.id],
      );
    }
  }

  const before = latest.metadata.sharedNamespaceIds;
  const after = payload.metadata.sharedNamespaceIds;
  const sharedChanged = JSON.stringify([...(before ?? [])].sort()) !== JSON.stringify([...(after ?? [])].sort());
  await appendAudit(client, {
    actorUserId: input.actorUserId,
    action: "proposal.retargeted",
    targetType: "proposal",
    targetId: p.id,
    // §74.9: under the namespace the proposal LEFT, so its admins can trace where it went.
    namespaceId: from.id,
    before: { state: p.state, namespaceId: from.id },
    after: {
      state,
      revisionNo,
      fromNamespaceId: from.id,
      fromNamespaceSlug: from.slug,
      toNamespaceId: to.id,
      toNamespaceSlug: to.slug,
      note: (input.note ?? "").trim() || null,
      via: input.via,
      ...(sharedChanged ? { sharedNamespaceIdsBefore: before ?? [], sharedNamespaceIdsAfter: after ?? [] } : {}),
    },
  });

  return {
    ok: true,
    from: { id: from.id, slug: from.slug },
    to: { id: to.id, slug: to.slug, displayName: to.display_name },
    revisionNo,
    state,
    skillSlug,
    canRead: input.actorUserId === p.submitted_by || canReviewNamespace(access, to.id),
  };
}
