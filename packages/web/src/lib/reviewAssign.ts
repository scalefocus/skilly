// Review assignments (SKILLY_SPEC.md §65) — who may be assigned, assigning and unassigning, the
// Start review claim, the whole-import assign, and the assignment + review-target views the
// proposal page and the queue read. Assignment is advisory: it never grants or limits authority
// (§65.1 decisions 1–2). The turn clock itself lives in the migration-0106 trigger, so every write
// path (this tier and the worker's MCP tools) keeps it right.
import type { Pool, PoolClient } from "pg";
import { canReviewNamespace, repoLabel, reviewTurn, reviewerIdsSql, REVIEW_ASSIGNED, type EffectiveAccess, type ProposalState } from "@skilly/shared";
import { appendAudit } from "./audit";
import { nameSql } from "./userLabel";

const OPEN = `('proposed','under_review','changes_requested')`;
const bootstrapGroup = (): string | null => process.env.SKILLY_BOOTSTRAP_ADMIN_GROUP?.trim() || null;

function isOpen(state: ProposalState): boolean {
  return state === "proposed" || state === "under_review" || state === "changes_requested";
}

/** An active reviewer of the namespace who isn't the proposal's submitter (§65.2). */
export async function isEligibleAssignee(db: Pool | PoolClient, namespaceId: string, submitterId: string, userId: string): Promise<boolean> {
  if (userId === submitterId) return false;
  const { rows } = await db.query<{ ok: boolean }>(
    `select exists (select 1 from (${reviewerIdsSql({ who: "all", ns: "$1", boot: "$2" })}) r where r.id = $3) as ok`,
    [namespaceId, bootstrapGroup(), userId],
  );
  return rows[0]?.ok === true;
}

export interface AssignableReviewer {
  id: string;
  name: string;
  avatar: string | null;
  /** A namespace admin of the proposal's namespace (listed first), not only a platform admin. */
  namespaceAdmin: boolean;
}

/** The picker: the eligible assignees, the namespace's admins first, each group alphabetical. */
export async function listAssignableReviewers(db: Pool, namespaceId: string, submitterId: string): Promise<AssignableReviewer[]> {
  const { rows } = await db.query<{ id: string; display_name: string; avatar: string | null; ns_admin: boolean }>(
    `with pool as (${reviewerIdsSql({ who: "all", ns: "$1", boot: "$2" })}),
          nsa as (${reviewerIdsSql({ who: "namespace", ns: "$1", boot: "$2" })})
     select u.id, ${nameSql("u.display_name", "u.email")} as display_name, u.avatar, (u.id in (select id from nsa)) as ns_admin
       from users u
      where u.id in (select id from pool) and u.id <> $3
      order by ns_admin desc, lower(${nameSql("u.display_name", "u.email")}), u.id`,
    [namespaceId, bootstrapGroup(), submitterId],
  );
  return rows.map((r) => ({ id: r.id, name: r.display_name, avatar: r.avatar, namespaceAdmin: r.ns_admin }));
}

/** `proposal.needs_review` to the whole pool of a namespace, minus the submitter (§65.4 step 1). */
export async function alertReviewerPool(
  db: Pool | PoolClient,
  input: { proposalId: string; namespaceId: string; submitterId: string; skillSlug: string | null; semver: string },
): Promise<void> {
  await db.query(
    `insert into notifications (user_id, type, payload)
     select r.id, 'proposal.needs_review', $4::jsonb
       from (${reviewerIdsSql({ who: "all", ns: "$1", boot: "$2" })}) r
      where r.id <> $3`,
    [
      input.namespaceId,
      bootstrapGroup(),
      input.submitterId,
      JSON.stringify({ proposalId: input.proposalId, skillSlug: input.skillSlug, semver: input.semver }),
    ],
  );
}

interface LockedProposal {
  id: string;
  state: ProposalState;
  target_namespace_id: string;
  namespace_slug: string;
  submitted_by: string;
  assignee_id: string | null;
  proposed_semver: string;
  skill_slug: string | null;
}

async function lockProposal(client: PoolClient, id: string): Promise<LockedProposal | null> {
  const { rows } = await client.query<LockedProposal>(
    `select p.id, p.state, p.target_namespace_id, n.slug as namespace_slug, p.submitted_by, p.assignee_id, p.proposed_semver,
            coalesce(s.slug, (select payload->'metadata'->>'skillSlug' from proposal_revisions
                               where proposal_id = p.id order by revision_no desc limit 1)) as skill_slug
       from proposals p
       join namespaces n on n.id = p.target_namespace_id
       left join skills s on s.id = p.target_skill_id
      where p.id = $1
      for update of p`,
    [id],
  );
  return rows[0] ?? null;
}

async function displayName(db: Pool | PoolClient, userId: string): Promise<string> {
  const { rows } = await db.query<{ display_name: string }>(`select ${nameSql("display_name", "email")} as display_name from users where id = $1`, [userId]);
  return rows[0]?.display_name ?? "Someone";
}

export type AssignResult =
  | { ok: true; changed: boolean; assignee: { id: string; name: string } | null }
  | { ok: false; status: 403 | 404 | 409 | 422; error: string; code?: string };

/**
 * Assign, reassign (`assigneeId`) or unassign (`null`) one proposal (§65.2). Any reviewer of the
 * proposal's namespace may; the submitter gets 403 and anyone else 404 (the proposal stays hidden).
 * Only open proposals; the new assignee must be eligible. The new assignee is notified unless they
 * assigned themselves; the previous one is not. Audited either way.
 */
export async function assignProposal(
  pool: Pool,
  input: { proposalId: string; assigneeId: string | null; access: EffectiveAccess; actorUserId: string },
): Promise<AssignResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const p = await lockProposal(client, input.proposalId);
    if (!p || !canReviewNamespace(input.access, p.target_namespace_id)) {
      await client.query("rollback");
      return p && p.submitted_by === input.actorUserId
        ? { ok: false, status: 403, error: "only a reviewer of this proposal's namespace can assign it" }
        : { ok: false, status: 404, error: "proposal not found" };
    }
    if (!isOpen(p.state)) {
      await client.query("rollback");
      return { ok: false, status: 409, error: "this proposal has been decided — its assignment is history now", code: "proposal_decided" };
    }
    if (input.assigneeId === p.assignee_id) {
      await client.query("rollback");
      return { ok: true, changed: false, assignee: p.assignee_id ? { id: p.assignee_id, name: await displayName(pool, p.assignee_id) } : null };
    }
    if (input.assigneeId && !(await isEligibleAssignee(client, p.target_namespace_id, p.submitted_by, input.assigneeId))) {
      await client.query("rollback");
      return { ok: false, status: 422, error: "that person can't review this proposal — pick a reviewer of its namespace other than the proposer", code: "assignee_not_eligible" };
    }

    await client.query(
      `update proposals set assignee_id = $2, assigned_by = $3, assignment_changed_at = now() where id = $1`,
      [p.id, input.assigneeId, input.actorUserId],
    );
    await appendAudit(client, {
      actorUserId: input.actorUserId,
      action: input.assigneeId ? "proposal.assigned" : "proposal.unassigned",
      targetType: "proposal",
      targetId: p.id,
      namespaceId: p.target_namespace_id,
      before: { assigneeId: p.assignee_id },
      after: input.assigneeId ? { from: p.assignee_id, to: input.assigneeId, reason: "manual" } : { from: p.assignee_id, reason: "manual" },
    });
    if (input.assigneeId && input.assigneeId !== input.actorUserId) {
      await client.query(
        `insert into notifications (user_id, type, payload) values ($1, $2, $3::jsonb)`,
        [
          input.assigneeId,
          REVIEW_ASSIGNED,
          JSON.stringify({ proposalId: p.id, ns: p.namespace_slug, slug: p.skill_slug, byName: await displayName(client, input.actorUserId) }),
        ],
      );
    }
    await client.query("commit");
    return { ok: true, changed: true, assignee: input.assigneeId ? { id: input.assigneeId, name: await displayName(pool, input.assigneeId) } : null };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * The Start review claim (§65.2): an UNASSIGNED proposal is assigned to the reviewer who starts its
 * review, in the caller's transaction — never the submitter, never over an existing assignee. No
 * notification (they assigned themselves). Returns true when it claimed.
 */
export async function claimOnStartReview(
  client: PoolClient,
  p: { id: string; namespaceId: string; submittedBy: string },
  actorUserId: string,
): Promise<boolean> {
  if (actorUserId === p.submittedBy) return false;
  const { rowCount } = await client.query(
    `update proposals set assignee_id = $2, assigned_by = $2, assignment_changed_at = now()
      where id = $1 and assignee_id is null`,
    [p.id, actorUserId],
  );
  if (!rowCount) return false;
  await appendAudit(client, {
    actorUserId,
    action: "proposal.assigned",
    targetType: "proposal",
    targetId: p.id,
    namespaceId: p.namespaceId,
    before: { assigneeId: null },
    after: { from: null, to: actorUserId, reason: "start_review" },
  });
  return true;
}

export type AssignImportResult =
  | { ok: true; assigned: number; reassigned: number }
  | { ok: false; status: 403 | 404 | 422; error: string; code?: string };

/**
 * *Assign all open* (§65.5): every open proposal of one repository import to one reviewer, in one
 * transaction. The import shares one namespace (and one submitter), so eligibility is checked once.
 * One audit row per proposal that changed; ONE `proposal.assigned` for the whole import.
 */
export async function assignImport(
  pool: Pool,
  input: { importId: string; assigneeId: string; access: EffectiveAccess; actorUserId: string },
): Promise<AssignImportResult> {
  const { rows: imp } = await pool.query<{ target_namespace_id: string; submitted_by: string | null; origin_url: string; ns: string }>(
    `select pi.target_namespace_id, pi.submitted_by, pi.origin_url, n.slug as ns
       from proposal_imports pi join namespaces n on n.id = pi.target_namespace_id where pi.id = $1`,
    [input.importId],
  );
  const i = imp[0];
  if (!i || !canReviewNamespace(input.access, i.target_namespace_id)) {
    return i && i.submitted_by === input.actorUserId
      ? { ok: false, status: 403, error: "only a reviewer of this import's namespace can assign it" }
      : { ok: false, status: 404, error: "import not found" };
  }
  if (!(await isEligibleAssignee(pool, i.target_namespace_id, i.submitted_by ?? "", input.assigneeId))) {
    return { ok: false, status: 422, error: "that person can't review these proposals — pick a reviewer of the namespace other than the proposer", code: "assignee_not_eligible" };
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: changed } = await client.query<{ id: string; from_id: string | null }>(
      `with old as (
         select id, assignee_id from proposals
          where import_id = $1 and state in ${OPEN} and assignee_id is distinct from $2 and submitted_by <> $2
          for update
       )
       update proposals p set assignee_id = $2, assigned_by = $3, assignment_changed_at = now()
         from old where p.id = old.id
       returning p.id, old.assignee_id as from_id`,
      [input.importId, input.assigneeId, input.actorUserId],
    );
    for (const r of changed) {
      await appendAudit(client, {
        actorUserId: input.actorUserId,
        action: "proposal.assigned",
        targetType: "proposal",
        targetId: r.id,
        namespaceId: i.target_namespace_id,
        before: { assigneeId: r.from_id },
        after: { from: r.from_id, to: input.assigneeId, reason: "import", importId: input.importId },
      });
    }
    if (changed.length > 0 && input.assigneeId !== input.actorUserId) {
      await client.query(
        `insert into notifications (user_id, type, payload) values ($1, $2, $3::jsonb)`,
        [
          input.assigneeId,
          REVIEW_ASSIGNED,
          JSON.stringify({ importId: input.importId, ns: i.ns, repo: repoLabel(i.origin_url), count: changed.length, byName: await displayName(client, input.actorUserId) }),
        ],
      );
    }
    await client.query("commit");
    return { ok: true, assigned: changed.length, reassigned: changed.filter((r) => r.from_id != null).length };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * GDPR erasure (§4, §65.9): clear the erased user's OPEN assignments in the erasure transaction,
 * audited as `ineligible` with the erasing admin as actor; the pool hears about each proposal that
 * waits on reviewers. Decided proposals keep the assignee (now the tombstone label).
 */
export async function unassignErasedUser(client: PoolClient, userId: string, actorUserId: string): Promise<number> {
  const { rows } = await client.query<{ id: string; target_namespace_id: string; submitted_by: string; state: ProposalState; proposed_semver: string; skill_slug: string | null }>(
    `update proposals p set assignee_id = null, assigned_by = $2, assignment_changed_at = now()
      where p.assignee_id = $1 and p.state in ${OPEN}
      returning p.id, p.target_namespace_id, p.submitted_by, p.state, p.proposed_semver,
                (select payload->'metadata'->>'skillSlug' from proposal_revisions
                  where proposal_id = p.id order by revision_no desc limit 1) as skill_slug`,
    [userId, actorUserId],
  );
  for (const r of rows) {
    await appendAudit(client, {
      actorUserId,
      action: "proposal.unassigned",
      targetType: "proposal",
      targetId: r.id,
      namespaceId: r.target_namespace_id,
      before: { assigneeId: userId },
      after: { from: userId, reason: "ineligible" },
    });
    if (reviewTurn(r.state) === "reviewer") {
      await alertReviewerPool(client, { proposalId: r.id, namespaceId: r.target_namespace_id, submitterId: r.submitted_by, skillSlug: r.skill_slug, semver: r.proposed_semver });
    }
  }
  return rows.length;
}

export interface AssignmentView {
  assignee: { id: string; name: string; avatar: string | null } | null;
  assignedAt: string | null;
  canAssign: boolean;
  canSelfAssign: boolean;
  /** The viewer's own user id — what *Assign to me* sends. */
  viewerId: string;
}

export interface ReviewTargetView {
  days: number;
  dueAt: string;
  overdue: boolean;
}

/** The proposal page's *Reviewer* and *Review target* lines (§65.6). */
export async function proposalAssignmentView(
  db: Pool,
  proposalId: string,
  access: EffectiveAccess,
  actorUserId: string,
): Promise<{ assignment: AssignmentView; reviewTarget: ReviewTargetView | null } | null> {
  const { rows } = await db.query<{
    state: ProposalState; target_namespace_id: string; submitted_by: string; assignee_id: string | null; assignee_name: string | null; assignee_avatar: string | null;
    assignment_changed_at: string | null; turn_due_at: string | null; review_target_days: number | null; overdue: boolean;
  }>(
    `select p.state, p.target_namespace_id, p.submitted_by, p.assignee_id, ${nameSql("au.display_name", "au.email")} as assignee_name, au.avatar as assignee_avatar,
            p.assignment_changed_at, p.turn_due_at, n.review_target_days,
            (p.turn_due_at is not null and p.turn_due_at <= now()) as overdue
       from proposals p
       join namespaces n on n.id = p.target_namespace_id
       left join users au on au.id = p.assignee_id
      where p.id = $1`,
    [proposalId],
  );
  const r = rows[0];
  if (!r) return null;
  const reviewer = canReviewNamespace(access, r.target_namespace_id);
  const open = isOpen(r.state);
  const canSelfAssign =
    reviewer && open && r.assignee_id !== actorUserId && (await isEligibleAssignee(db, r.target_namespace_id, r.submitted_by, actorUserId));
  return {
    assignment: {
      assignee: r.assignee_id ? { id: r.assignee_id, name: r.assignee_name ?? "Someone", avatar: r.assignee_avatar } : null,
      assignedAt: r.assignee_id ? r.assignment_changed_at : null,
      canAssign: reviewer && open,
      canSelfAssign,
      viewerId: actorUserId,
    },
    reviewTarget:
      reviewTurn(r.state) === "reviewer" && r.turn_due_at && r.review_target_days
        ? { days: r.review_target_days, dueAt: r.turn_due_at, overdue: r.overdue }
        : null,
  };
}
