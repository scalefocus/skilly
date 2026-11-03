// Live-DB integration test for review assignments and targets (SKILLY_SPEC.md §65.12). Gated behind
// SKILLY_DB_E2E=1; requires a migrated Postgres at DATABASE_URL.
//
// Covers: the SQL business-day function matches the shared TS one; the migration-0106 trigger
// dates a turn from the namespace's target, starts a new turn on a turn change, re-dates on a
// target change and clears a stamp whose instant moved into the future; assign / reassign /
// unassign / self-assign with their notifications, audit rows and refusals; the Start review
// claim; resubmit routed to the assignee alone; the queue's assignee / overdue / namespace
// filters; the badge's reviewer half; Assign all open; the namespace settings and live counts;
// and GDPR erasure unassigning open proposals only.
//
// Per-run rows (namespace, users, proposals) are never deleted: audit_log is append-only and
// references them.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { addBusinessDays, type EffectiveAccess, type Role } from "@skilly/shared";
import type { ArtifactStore } from "./objectStore";

/** No action here touches the object store. */
const store: ArtifactStore = {
  get: async () => { throw new Error("unexpected get"); },
  put: async () => { throw new Error("unexpected put"); },
  delete: async () => {},
  list: async () => [],
};

const enabled = process.env.SKILLY_DB_E2E === "1";

after(async () => {
  if (enabled) {
    const { pool } = await import("./db");
    await pool.end();
  }
});

test("§65 review assignments and targets", { skip: !enabled }, async () => {
  const { pool } = await import("./db");
  const ra = await import("./reviewAssign");
  const { performProposalAction, listReviewQueue } = await import("./proposals");
  const { updateNamespaceSettings, listAdministeredNamespaces } = await import("./namespaceAdmin");
  const { getNavBadges } = await import("./navbadges");
  const tag = `ra${Date.now().toString(36)}`;

  const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await pool.query(sql, params)).rows[0] as T;
  const mkUser = async (who: string) =>
    (await one<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ($1, $2, $3) returning id`,
      [`${tag}-${who}`, `${tag}-${who}@org`, `${tag} ${who}`],
    )).id;

  const nsSlug = `${tag}-ns`;
  const ns = (await one<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ($1, $1, true) returning id`,
    [nsSlug],
  )).id;
  const otherNs = (await one<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ($1, $1, true) returning id`,
    [`${tag}-other`],
  )).id;
  const submitter = await mkUser("submitter");
  const admin1 = await mkUser("admin1");
  const admin2 = await mkUser("admin2");
  const member = await mkUser("member");
  const outsider = await mkUser("outsider");
  const mkGroup = async (name: string, role: Role, users: string[]) => {
    const g = (await one<{ id: string }>(`insert into groups (entra_object_id, display_name) values ($1, $1) returning id`, [`${tag}-${name}`])).id;
    await pool.query(`insert into role_mappings (group_id, namespace_id, role) values ($1, $2, $3)`, [g, ns, role]);
    for (const u of users) await pool.query(`insert into group_memberships (group_id, user_id) values ($1, $2)`, [g, u]);
  };
  await mkGroup("admins", "namespace_admin", [admin1, admin2]);
  await mkGroup("members", "namespace_member", [member]);

  const nsAdmin: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map<string, Role>([[ns, "namespace_admin"]]) };
  const nobody: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map() };
  const platform: EffectiveAccess = { isPlatformAdmin: true, namespaceRoles: new Map() };

  const mkProposal = async (slug: string, state = "proposed", importId: string | null = null) => {
    const id = (await one<{ id: string }>(
      `insert into proposals (target_namespace_id, proposed_semver, state, submitted_by, import_id)
       values ($1, '1.0.0', $2, $3, $4) returning id`,
      [ns, state, submitter, importId],
    )).id;
    await pool.query(
      `insert into proposal_revisions (proposal_id, revision_no, payload, author) values ($1, 1, $2::jsonb, $3)`,
      [id, JSON.stringify({ metadata: { skillSlug: slug, title: slug, description: "d", categories: [], toolHarness: "generic" } }), submitter],
    );
    return id;
  };
  type Turn = { turn_started_at: Date; turn_due_at: Date | null; turn_escalate_at: Date | null; turn_reminded_at: Date | null; assignee_id: string | null };
  const turn = (id: string) =>
    one<Turn>(`select turn_started_at, turn_due_at, turn_escalate_at, turn_reminded_at, assignee_id from proposals where id = $1`, [id]);
  const notes = async (userId: string, type: string, proposalId?: string) =>
    (await pool.query<{ payload: Record<string, unknown> }>(
      `select payload from notifications where user_id = $1 and type = $2 ${proposalId ? `and payload->>'proposalId' = $3` : ""}`,
      proposalId ? [userId, type, proposalId] : [userId, type],
    )).rows;
  const setTarget = async (days: number | null) => {
    const r = await updateNamespaceSettings(platform, ns, { reviewTargetDays: days }, admin1, "skilly");
    assert.ok(r.ok, JSON.stringify(r));
  };

  // ── skilly_add_business_days === addBusinessDays ────────────────────────────────────────
  for (const iso of ["2026-11-06T15:00:00Z", "2026-11-07T10:00:00Z", "2026-11-08T23:30:00Z", "2026-11-04T09:00:00Z", "2026-11-06T00:00:00Z"]) {
    for (const n of [1, 2, 3, 4, 5, 7, 10, 30]) {
      const { d } = await one<{ d: Date }>(`select skilly_add_business_days($1::timestamptz, $2) as d`, [iso, n]);
      assert.equal(new Date(d).toISOString(), addBusinessDays(new Date(iso), n).toISOString(), `${iso} + ${n}`);
    }
  }

  // ── the turn trigger ────────────────────────────────────────────────────────────────────
  const pTurn = await mkProposal(`${tag}-turn`);
  assert.equal((await turn(pTurn)).turn_due_at, null, "no target, no due date");
  await setTarget(2);
  let t = await turn(pTurn);
  assert.equal(t.turn_due_at?.toISOString(), addBusinessDays(t.turn_started_at, 2).toISOString());
  assert.equal(t.turn_escalate_at?.toISOString(), addBusinessDays(t.turn_started_at, 4).toISOString());
  const bad = await updateNamespaceSettings(platform, ns, { reviewTargetDays: 31 }, admin1, "skilly");
  assert.ok(!bad.ok && bad.status === 422);
  // Start review keeps the reviewer turn; request changes starts the proposer turn (no escalation).
  const firstStart = t.turn_started_at.getTime();
  await pool.query(`update proposals set turn_started_at = now() - interval '1 hour' where id = $1`, [pTurn]);
  await pool.query(`update proposals set state = 'under_review' where id = $1`, [pTurn]);
  assert.ok((await turn(pTurn)).turn_started_at.getTime() < firstStart, "start review is the same turn");
  await pool.query(`update proposals set state = 'changes_requested' where id = $1`, [pTurn]);
  t = await turn(pTurn);
  assert.ok(t.turn_started_at.getTime() >= firstStart, "a new turn");
  assert.ok(t.turn_due_at);
  assert.equal(t.turn_escalate_at, null, "the proposer turn has no escalation");
  // A raised target moves a past due date into the future and clears its reminder stamp.
  await pool.query(`update proposals set state = 'under_review' where id = $1`, [pTurn]);
  await pool.query(`update proposals set turn_started_at = now() - interval '30 days' where id = $1`, [pTurn]);
  await pool.query(`update proposals set turn_reminded_at = now() where id = $1`, [pTurn]);
  assert.ok((await turn(pTurn)).turn_due_at!.getTime() < Date.now());
  await setTarget(30);
  t = await turn(pTurn);
  assert.ok(t.turn_due_at!.getTime() > Date.now());
  assert.equal(t.turn_reminded_at, null, "the stamp is cleared so the reminder fires at the new instant");
  await setTarget(null);
  t = await turn(pTurn);
  assert.equal(t.turn_due_at, null);
  assert.equal(t.turn_escalate_at, null);
  await setTarget(2);
  await pool.query(`update proposals set state = 'rejected' where id = $1`, [pTurn]); // out of the overdue counts below

  // ── assign / reassign / unassign ────────────────────────────────────────────────────────
  const pA = await mkProposal(`${tag}-assign`);
  let a = await ra.assignProposal(pool, { proposalId: pA, assigneeId: admin2, access: nsAdmin, actorUserId: admin1 });
  assert.ok(a.ok && a.changed && a.assignee?.id === admin2);
  assert.equal((await notes(admin2, "proposal.assigned", pA)).length, 1, "the new assignee hears");
  const audit = await one<{ after: Record<string, unknown> }>(
    `select after from audit_log where action = 'proposal.assigned' and target_id = $1 order by created_at desc limit 1`,
    [pA],
  );
  assert.equal(audit.after.reason, "manual");
  assert.equal(audit.after.to, admin2);
  a = await ra.assignProposal(pool, { proposalId: pA, assigneeId: admin2, access: nsAdmin, actorUserId: admin1 });
  assert.ok(a.ok && !a.changed, "assigning the current assignee is a no-op");
  for (const who of [submitter, member, outsider]) {
    const r = await ra.assignProposal(pool, { proposalId: pA, assigneeId: who, access: nsAdmin, actorUserId: admin1 });
    assert.ok(!r.ok && r.status === 422 && r.code === "assignee_not_eligible", who);
  }
  let r2 = await ra.assignProposal(pool, { proposalId: pA, assigneeId: admin1, access: nobody, actorUserId: submitter });
  assert.ok(!r2.ok && r2.status === 403, "the submitter sees the proposal but can't assign it");
  r2 = await ra.assignProposal(pool, { proposalId: pA, assigneeId: admin1, access: nobody, actorUserId: outsider });
  assert.ok(!r2.ok && r2.status === 404, "anyone else gets 404");
  a = await ra.assignProposal(pool, { proposalId: pA, assigneeId: admin1, access: nsAdmin, actorUserId: admin1 });
  assert.ok(a.ok && a.changed);
  assert.equal((await notes(admin1, "proposal.assigned", pA)).length, 0, "self-assign notifies nobody");
  a = await ra.assignProposal(pool, { proposalId: pA, assigneeId: null, access: nsAdmin, actorUserId: admin1 });
  assert.ok(a.ok && a.assignee === null);
  assert.ok(await one(`select 1 from audit_log where action = 'proposal.unassigned' and target_id = $1`, [pA]));
  const pDecided = await mkProposal(`${tag}-decided`, "rejected");
  r2 = await ra.assignProposal(pool, { proposalId: pDecided, assigneeId: admin2, access: nsAdmin, actorUserId: admin1 });
  assert.ok(!r2.ok && r2.status === 409 && r2.code === "proposal_decided");
  const picker = await ra.listAssignableReviewers(pool, ns, submitter);
  assert.ok(picker.some((x) => x.id === admin1 && x.namespaceAdmin));
  assert.ok(!picker.some((x) => x.id === submitter || x.id === member || x.id === outsider));

  // ── the Start review claim ──────────────────────────────────────────────────────────────
  const pClaim = await mkProposal(`${tag}-claim`);
  const started = await performProposalAction(pool, { proposalId: pClaim, action: "start_review", access: nsAdmin, actorUserId: admin2 }, store);
  assert.ok(started.ok);
  assert.equal((await turn(pClaim)).assignee_id, admin2, "starting the review claims it");
  assert.equal((await notes(admin2, "proposal.assigned", pClaim)).length, 0);
  const pClaimed = await mkProposal(`${tag}-claimed`);
  await pool.query(`update proposals set assignee_id = $2 where id = $1`, [pClaimed, admin1]);
  await performProposalAction(pool, { proposalId: pClaimed, action: "start_review", access: nsAdmin, actorUserId: admin2 }, store);
  assert.equal((await turn(pClaimed)).assignee_id, admin1, "never over an existing assignee");

  // ── resubmit routed to the assignee alone ───────────────────────────────────────────────
  const pRoute = await mkProposal(`${tag}-route`, "changes_requested");
  await pool.query(`update proposals set assignee_id = $2 where id = $1`, [pRoute, admin2]);
  const resub = await performProposalAction(pool, { proposalId: pRoute, action: "resubmit", access: nobody, actorUserId: submitter }, store);
  assert.ok(resub.ok, JSON.stringify(resub));
  assert.equal((await notes(admin2, "proposal.needs_review", pRoute)).length, 1);
  assert.equal((await notes(admin1, "proposal.needs_review", pRoute)).length, 0, "other reviewers stay quiet");

  // ── queue filters ───────────────────────────────────────────────────────────────────────
  const pLate = await mkProposal(`${tag}-late`);
  await pool.query(`update proposals set turn_started_at = now() - interval '30 days' where id = $1`, [pLate]);
  const ids = (page: { items: { id: string }[] }) => page.items.map((i) => i.id);
  const mineQ = await listReviewQueue(pool, nsAdmin, { namespaceSlug: nsSlug, assignee: "me", userId: admin2 });
  assert.ok(ids(mineQ).includes(pRoute) && ids(mineQ).includes(pClaim));
  assert.ok(!ids(mineQ).includes(pLate));
  const noneQ = await listReviewQueue(pool, nsAdmin, { namespaceSlug: nsSlug, assignee: "none" });
  assert.ok(ids(noneQ).includes(pLate) && !ids(noneQ).includes(pRoute));
  const lateQ = await listReviewQueue(pool, nsAdmin, { namespaceSlug: nsSlug, overdue: true });
  assert.deepEqual(ids(lateQ), [pLate]);
  assert.equal(lateQ.total, 1, "the counts follow the filters");
  assert.ok(lateQ.items[0]!.reviewDueAt);
  const elsewhere = await listReviewQueue(pool, platform, { namespaceSlug: `${tag}-other` });
  assert.equal(elsewhere.items.length, 0);
  void otherNs;

  // ── the badge's reviewer half ───────────────────────────────────────────────────────────
  const reviewerTurnAssigned = async (u: string) =>
    Number((await one<{ n: string }>(
      `select count(*)::text as n from proposals where target_namespace_id = $1 and state in ('proposed','under_review') and assignee_id = $2`,
      [ns, u],
    )).n);
  const b1 = await getNavBadges({ ...nsAdmin, userId: admin1 });
  const b2 = await getNavBadges({ ...nsAdmin, userId: admin2 });
  assert.equal(b2.review - b1.review, (await reviewerTurnAssigned(admin2)) - (await reviewerTurnAssigned(admin1)));

  // ── Assign all open (imports) ───────────────────────────────────────────────────────────
  const imp = (await one<{ id: string }>(
    `insert into proposal_imports (submitted_by, target_namespace_id, origin_url, ref, mode) values ($1, $2, 'https://github.com/acme/skills.git', 'main', 'review') returning id`,
    [submitter, ns],
  )).id;
  const i1 = await mkProposal(`${tag}-i1`, "proposed", imp);
  const i2 = await mkProposal(`${tag}-i2`, "proposed", imp);
  await mkProposal(`${tag}-i3`, "accepted", imp);
  await pool.query(`update proposals set assignee_id = $2 where id = $1`, [i2, admin1]);
  const bulk = await ra.assignImport(pool, { importId: imp, assigneeId: admin2, access: nsAdmin, actorUserId: admin1 });
  assert.deepEqual(bulk, { ok: true, assigned: 2, reassigned: 1 });
  assert.equal((await turn(i1)).assignee_id, admin2);
  const importNotes = (await notes(admin2, "proposal.assigned")).filter((n) => n.payload.importId === imp);
  assert.equal(importNotes.length, 1);
  assert.equal(importNotes[0]!.payload.count, 2);
  const badBulk = await ra.assignImport(pool, { importId: imp, assigneeId: member, access: nsAdmin, actorUserId: admin1 });
  assert.ok(!badBulk.ok && badBulk.status === 422);

  // ── the namespace page's live counts ────────────────────────────────────────────────────
  const view = (await listAdministeredNamespaces(platform, "skilly")).find((n) => n.id === ns)!;
  assert.equal(view.reviewTargetDays, 2);
  const counts = await one<{ open: number; unassigned: number }>(
    `select count(*)::int as open, count(*) filter (where assignee_id is null)::int as unassigned
       from proposals where target_namespace_id = $1 and state in ('proposed','under_review','changes_requested')`,
    [ns],
  );
  assert.equal(view.openProposals, counts.open);
  assert.equal(view.unassignedProposals, counts.unassigned);
  assert.equal(view.overdueProposals, 1);

  // ── GDPR erasure unassigns open proposals only ──────────────────────────────────────────
  const pHistory = await mkProposal(`${tag}-history`);
  await pool.query(`update proposals set assignee_id = $2 where id = $1`, [pHistory, admin2]);
  await pool.query(`update proposals set state = 'rejected' where id = $1`, [pHistory]);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const n = await ra.unassignErasedUser(client, admin2, admin1);
    await client.query("commit");
    assert.ok(n >= 3, `cleared ${n}`);
  } finally {
    client.release();
  }
  assert.equal((await turn(i1)).assignee_id, null);
  assert.equal((await turn(pRoute)).assignee_id, null);
  assert.equal((await turn(pHistory)).assignee_id, admin2, "a decided proposal keeps its assignee");
  assert.equal((await notes(admin1, "proposal.needs_review", pRoute)).length, 1, "the pool hears about a reviewer-turn proposal");
});
