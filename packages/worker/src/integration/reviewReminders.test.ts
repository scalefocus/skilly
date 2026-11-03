// Live-DB integration test for the review reminder sweep (SKILLY_SPEC.md §65.4, §65.12). Gated behind
// SKILLY_DB_E2E=1; requires a migrated Postgres at DATABASE_URL.
//
// Validates: an ineligible assignee is cleared (audited, the pool alerted); the overdue reminder
// goes to the assignee, else the namespace's admins; the escalation goes one level up; the proposer
// is reminded once with no escalation; reminders fold into one unread row per recipient, type and
// namespace; a second pass sends nothing; a new turn re-arms the reminder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepReviewReminders } from "../reviewReminders.js";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("review reminders: eligibility, overdue, escalation, proposer, folding, once per turn", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const tag = `rr${Date.now().toString(36)}`;
  try {
    const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await pool.query(sql, params)).rows[0] as T;
    const mkUser = async (who: string) =>
      (await one<{ id: string }>(
        `insert into users (entra_object_id, email, display_name) values ($1, $2, $1) returning id`,
        [`${tag}-${who}`, `${tag}-${who}@org`],
      )).id;
    const ns = (await one<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ($1, $1, true) returning id`,
      [`${tag}-ns`],
    )).id;
    const submitter = await mkUser("submitter");
    const admin1 = await mkUser("admin1");
    const admin2 = await mkUser("admin2");
    const platformAdmin = await mkUser("platform");
    const outsider = await mkUser("outsider");
    const mkGroup = async (name: string, role: string, nsId: string | null, users: string[]) => {
      const g = (await one<{ id: string }>(`insert into groups (entra_object_id, display_name) values ($1, $1) returning id`, [`${tag}-${name}`])).id;
      await pool.query(`insert into role_mappings (group_id, namespace_id, role) values ($1, $2, $3)`, [g, nsId, role]);
      for (const u of users) await pool.query(`insert into group_memberships (group_id, user_id) values ($1, $2)`, [g, u]);
    };
    await mkGroup("admins", "namespace_admin", ns, [admin1, admin2]);
    await mkGroup("platform", "platform_admin", null, [platformAdmin]);

    const mkProposal = async (slug: string, state: string, assignee: string | null) => {
      const id = (await one<{ id: string }>(
        `insert into proposals (target_namespace_id, proposed_semver, state, submitted_by, assignee_id)
         values ($1, '1.0.0', $2, $3, $4) returning id`,
        [ns, state, submitter, assignee],
      )).id;
      await pool.query(
        `insert into proposal_revisions (proposal_id, revision_no, payload, author) values ($1, 1, $2::jsonb, $3)`,
        [id, JSON.stringify({ metadata: { skillSlug: slug, title: slug } }), submitter],
      );
      // Thirty calendar days ago: past both the 1-business-day due date and the 2-day escalation.
      await pool.query(`update proposals set turn_started_at = now() - interval '30 days' where id = $1`, [id]);
      return id;
    };
    await pool.query(`update namespaces set review_target_days = 1 where id = $1`, [ns]);
    const pAssigned = await mkProposal(`${tag}-a`, "under_review", admin1);
    const pUnassigned = await mkProposal(`${tag}-u`, "proposed", null);
    const pChanges = await mkProposal(`${tag}-c`, "changes_requested", null);
    const pIneligible = await mkProposal(`${tag}-i`, "proposed", outsider);

    const unread = async (userId: string, type: string) =>
      (await pool.query<{ id: string; payload: { count: number; proposalIds: string[]; ns: string; days: number } }>(
        `select id, payload from notifications where user_id = $1 and type = $2 and payload->>'nsId' = $3 and read_at is null`,
        [userId, type, ns],
      )).rows;

    const first = await sweepReviewReminders(pool);
    assert.ok(first.unassigned >= 1 && first.overdue >= 3 && first.escalated >= 2 && first.proposer >= 1, JSON.stringify(first));

    // Step 1: the outsider is cleared, audited, and the pool hears about the proposal.
    assert.equal((await one<{ assignee_id: string | null }>(`select assignee_id from proposals where id = $1`, [pIneligible])).assignee_id, null);
    const audit = await one<{ actor_user_id: string | null; after: { reason: string } }>(
      `select actor_user_id, after from audit_log where action = 'proposal.unassigned' and target_id = $1`,
      [pIneligible],
    );
    assert.equal(audit.actor_user_id, null);
    assert.equal(audit.after.reason, "ineligible");
    assert.ok(await one(`select 1 from notifications where user_id = $1 and type = 'proposal.needs_review' and payload->>'proposalId' = $2`, [admin1, pIneligible]));

    // Step 2: admin1 is reminded about its own assignment AND the unassigned ones — one folded row.
    const a1 = await unread(admin1, "proposal.review_overdue");
    assert.equal(a1.length, 1, "one folded row per recipient, type and namespace");
    for (const p of [pAssigned, pUnassigned, pIneligible]) assert.ok(a1[0]!.payload.proposalIds.includes(p), p);
    assert.equal(a1[0]!.payload.count, a1[0]!.payload.proposalIds.length);
    assert.equal(a1[0]!.payload.days, 1);
    const a2 = await unread(admin2, "proposal.review_overdue");
    assert.ok(!a2[0]!.payload.proposalIds.includes(pAssigned), "the assigned proposal reminds its assignee only");
    assert.equal((await unread(submitter, "proposal.review_overdue")).length, 0, "never the submitter");

    // Step 3: assigned → the other namespace admins; unassigned → the platform admins.
    const e2 = await unread(admin2, "proposal.review_escalated");
    assert.ok(e2[0]!.payload.proposalIds.includes(pAssigned));
    assert.equal((await unread(admin1, "proposal.review_escalated")).length, 0, "not the assignee");
    const ep = await unread(platformAdmin, "proposal.review_escalated");
    assert.ok(ep[0]!.payload.proposalIds.includes(pUnassigned));
    assert.ok(!ep[0]!.payload.proposalIds.includes(pAssigned));

    // Step 4: the proposer, once, and the proposer turn never escalates.
    const c = await unread(submitter, "proposal.changes_reminder");
    assert.deepEqual(c[0]!.payload.proposalIds, [pChanges]);
    assert.equal((await one<{ turn_escalate_at: Date | null }>(`select turn_escalate_at from proposals where id = $1`, [pChanges])).turn_escalate_at, null);

    // A second pass sends nothing more for these proposals.
    await sweepReviewReminders(pool);
    assert.equal((await unread(admin1, "proposal.review_overdue"))[0]!.payload.count, a1[0]!.payload.count);
    assert.equal((await unread(submitter, "proposal.changes_reminder"))[0]!.payload.count, 1);

    // A new turn re-arms: read the rows, send it back and resubmit it, then let it run late again.
    await pool.query(`update notifications set read_at = now() where user_id = $1 and type = 'proposal.review_overdue'`, [admin1]);
    await pool.query(`update proposals set state = 'changes_requested' where id = $1`, [pAssigned]);
    await pool.query(`update proposals set state = 'under_review' where id = $1`, [pAssigned]);
    assert.equal((await one<{ turn_reminded_at: Date | null }>(`select turn_reminded_at from proposals where id = $1`, [pAssigned])).turn_reminded_at, null);
    await pool.query(`update proposals set turn_started_at = now() - interval '30 days' where id = $1`, [pAssigned]);
    await sweepReviewReminders(pool);
    const again = await unread(admin1, "proposal.review_overdue");
    assert.equal(again.length, 1, "a new unread row after the old one was read");
    assert.deepEqual(again[0]!.payload.proposalIds, [pAssigned]);
  } finally {
    await pool.end();
  }
});
