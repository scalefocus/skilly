// Review reminders (SKILLY_SPEC.md §65.4) — a leader-only sweep, every 15 minutes, four steps:
//   1. eligibility: an assignee who can no longer review the proposal (role removed, leaver,
//      erased) is unassigned, audited, and the pool hears about a proposal waiting on reviewers;
//   2. overdue: a reviewer-turn proposal past its due instant reminds its assignee — else the
//      namespace's admins, else (global, or no namespace admin) the platform admins;
//   3. escalation: past twice the target, one level up — the namespace's admins (minus the
//      assignee) for an assigned proposal, the platform admins for an unassigned one;
//   4. proposer: a changes_requested turn past the target reminds the submitter once.
// The three reminder types fold into ONE unread row per recipient, type and namespace (migration
// 0106's partial unique index), refreshed in place until read so it emails at most once. The turn
// clock itself (due/escalation instants, stamps reset per turn) is the migration-0106 trigger.
import type { Pool, PoolClient } from "pg";
import {
  REVIEW_CHANGES_REMINDER,
  REVIEW_ESCALATED,
  REVIEW_OVERDUE,
  reviewerIdsSql,
} from "@skilly/shared";
import { M } from "./metrics.js";

export const REVIEW_REMINDER_INTERVAL_MS = 15 * 60_000;

const OPEN = `('proposed','under_review','changes_requested')`;
const GLOBAL_SLUG = "global";
const boot = (): string | null => process.env.SKILLY_BOOTSTRAP_ADMIN_GROUP?.trim() || null;

export interface ReviewReminderResult {
  unassigned: number;
  overdue: number;
  escalated: number;
  proposer: number;
}

interface DueRow {
  id: string;
  target_namespace_id: string;
  namespace_slug: string;
  review_target_days: number | null;
  submitted_by: string;
  assignee_id: string | null;
  proposed_semver: string;
  state: string;
  skill_slug: string | null;
}

const DUE_SELECT = `
  select p.id, p.target_namespace_id, n.slug as namespace_slug, n.review_target_days, p.submitted_by,
         p.assignee_id, p.proposed_semver, p.state,
         coalesce(s.slug, (select payload->'metadata'->>'skillSlug' from proposal_revisions
                            where proposal_id = p.id order by revision_no desc limit 1)) as skill_slug
    from proposals p
    join namespaces n on n.id = p.target_namespace_id
    left join skills s on s.id = p.target_skill_id`;

async function ids(db: Pool | PoolClient, sql: string, params: unknown[]): Promise<string[]> {
  return (await db.query<{ id: string }>(sql, params)).rows.map((r) => r.id);
}

/** The namespace's active namespace admins. */
function namespaceAdmins(db: Pool | PoolClient, namespaceId: string): Promise<string[]> {
  return ids(db, reviewerIdsSql({ who: "namespace", ns: "$1", boot: "$2" }), [namespaceId, boot()]);
}

/** The active platform admins, with the bootstrap admin group. */
function platformAdmins(db: Pool | PoolClient): Promise<string[]> {
  return ids(db, reviewerIdsSql({ who: "platform", boot: "$1" }), [boot()]);
}

/**
 * Fold one proposal into each recipient's unread reminder row of `type` for its namespace — a new
 * row, or the existing unread one with the proposal added (`proposalIds`, `count`). The update keeps
 * `delivered_at`, so a folded row emails at most once until it is read (§12 coalescing).
 */
async function foldReminder(db: Pool | PoolClient, type: string, recipients: readonly string[], r: DueRow): Promise<void> {
  if (recipients.length === 0) return;
  await db.query(
    `insert into notifications (user_id, type, payload)
     select u.id, $2,
            jsonb_build_object('nsId', $3::text, 'ns', $4::text, 'days', $5::int, 'count', 1,
                               'proposalIds', jsonb_build_array($6::text), 'slug', $7::text)
       from users u
      where u.id = any($1::uuid[]) and u.status = 'active' and u.erased_at is null
     on conflict (user_id, type, (payload->>'nsId'))
       where type in ('proposal.review_overdue', 'proposal.review_escalated', 'proposal.changes_reminder') and read_at is null
     do update set
       payload = case when notifications.payload->'proposalIds' ? $6::text then notifications.payload
                      else notifications.payload || jsonb_build_object(
                             'proposalIds', (notifications.payload->'proposalIds') || jsonb_build_array($6::text),
                             'count', jsonb_array_length(notifications.payload->'proposalIds') + 1,
                             'days', $5::int)
                 end,
       created_at = now()`,
    [[...new Set(recipients)], type, r.target_namespace_id, r.namespace_slug, r.review_target_days, r.id, r.skill_slug],
  );
}

/** Step 1: clear every open assignment whose assignee can no longer review the proposal. */
async function clearIneligible(pool: Pool): Promise<number> {
  const { rows } = await pool.query<DueRow>(
    `${DUE_SELECT}
      where p.assignee_id is not null and p.state in ${OPEN}
        and (p.assignee_id = p.submitted_by
             or not exists (select 1 from (${reviewerIdsSql({ who: "all", ns: "p.target_namespace_id", boot: "$1" })}) r
                             where r.id = p.assignee_id))`,
    [boot()],
  );
  let n = 0;
  for (const r of rows) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const { rowCount } = await client.query(
        `update proposals set assignee_id = null, assigned_by = null, assignment_changed_at = now()
          where id = $1 and assignee_id = $2`,
        [r.id, r.assignee_id],
      );
      if (rowCount) {
        await client.query(
          `insert into audit_log (actor_user_id, action, target_type, target_id, namespace_id, before, after, source)
           values (null, 'proposal.unassigned', 'proposal', $1, $2, $3::jsonb, $4::jsonb, 'worker')`,
          [r.id, r.target_namespace_id, JSON.stringify({ assigneeId: r.assignee_id }), JSON.stringify({ from: r.assignee_id, reason: "ineligible" })],
        );
        if (r.state === "proposed" || r.state === "under_review") {
          await client.query(
            `insert into notifications (user_id, type, payload)
             select r.id, 'proposal.needs_review', $4::jsonb
               from (${reviewerIdsSql({ who: "all", ns: "$1", boot: "$2" })}) r
              where r.id <> $3`,
            [r.target_namespace_id, boot(), r.submitted_by, JSON.stringify({ proposalId: r.id, skillSlug: r.skill_slug, semver: r.proposed_semver })],
          );
        }
        n++;
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }
  return n;
}

/** Who a reviewer-turn reminder goes to (§65.4 step 2). */
export async function overdueRecipients(db: Pool | PoolClient, r: Pick<DueRow, "assignee_id" | "target_namespace_id" | "namespace_slug" | "submitted_by">): Promise<string[]> {
  let to: string[];
  if (r.assignee_id) to = [r.assignee_id];
  else {
    const nsAdmins = r.namespace_slug === GLOBAL_SLUG ? [] : await namespaceAdmins(db, r.target_namespace_id);
    to = nsAdmins.length > 0 ? nsAdmins : await platformAdmins(db);
  }
  return to.filter((id) => id !== r.submitted_by);
}

/** Who a reviewer-turn escalation goes to (§65.4 step 3), from the proposal's current state. */
export async function escalationRecipients(db: Pool | PoolClient, r: Pick<DueRow, "assignee_id" | "target_namespace_id" | "namespace_slug" | "submitted_by">): Promise<string[]> {
  const nsAdmins = r.namespace_slug === GLOBAL_SLUG ? [] : await namespaceAdmins(db, r.target_namespace_id);
  let to: string[];
  if (r.assignee_id) {
    const others = nsAdmins.filter((id) => id !== r.assignee_id);
    to = others.length > 0 ? others : (await platformAdmins(db)).filter((id) => id !== r.assignee_id);
  } else {
    // The reminder already reached the namespace's admins — or, for global / no namespace admin,
    // the platform admins, in which case there is no level left to escalate to.
    to = nsAdmins.length > 0 ? await platformAdmins(db) : [];
  }
  return to.filter((id) => id !== r.submitted_by);
}

async function remindStep(
  pool: Pool,
  where: string,
  stamp: "turn_reminded_at" | "turn_escalated_at",
  type: string,
  recipients: (r: DueRow) => Promise<string[]>,
): Promise<number> {
  const { rows } = await pool.query<DueRow>(`${DUE_SELECT} where ${where} order by p.turn_started_at, p.id`);
  let n = 0;
  for (const r of rows) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      // Claim the stamp first: a row another pass already stamped is skipped, so each turn's
      // reminder (and escalation) is sent exactly once.
      const { rowCount } = await client.query(`update proposals set ${stamp} = now() where id = $1 and ${stamp} is null`, [r.id]);
      if (rowCount) {
        await foldReminder(client, type, await recipients(r), r);
        n++;
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }
  return n;
}

/** One pass of the four steps. Safe to call often: every send is claimed by its stamp first. */
export async function sweepReviewReminders(pool: Pool): Promise<ReviewReminderResult> {
  const unassigned = await clearIneligible(pool);
  if (unassigned) M.reviewUnassignedIneligible.add(unassigned);

  const overdue = await remindStep(
    pool,
    `p.state in ('proposed','under_review') and p.turn_due_at is not null and p.turn_due_at <= now() and p.turn_reminded_at is null`,
    "turn_reminded_at",
    REVIEW_OVERDUE,
    (r) => overdueRecipients(pool, r),
  );
  const escalated = await remindStep(
    pool,
    `p.state in ('proposed','under_review') and p.turn_escalate_at is not null and p.turn_escalate_at <= now() and p.turn_escalated_at is null`,
    "turn_escalated_at",
    REVIEW_ESCALATED,
    (r) => escalationRecipients(pool, r),
  );
  const proposer = await remindStep(
    pool,
    `p.state = 'changes_requested' and p.turn_due_at is not null and p.turn_due_at <= now() and p.turn_reminded_at is null`,
    "turn_reminded_at",
    REVIEW_CHANGES_REMINDER,
    async (r) => [r.submitted_by],
  );
  if (overdue) M.reviewReminders.add(overdue, { kind: "overdue" });
  if (escalated) M.reviewReminders.add(escalated, { kind: "escalated" });
  if (proposer) M.reviewReminders.add(proposer, { kind: "proposer" });
  return { unassigned, overdue, escalated, proposer };
}
