// Live-DB integration test for moving a NEW-SKILL proposal to another namespace (SKILLY_SPEC.md §74).
// Gated by SKILLY_DB_E2E=1:
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Covers: the move targets a reviewer is offered; the hand-off (state, assignee, fresh turn, the
// move revision and its note, the default shared-list edit, the audit row under the old namespace,
// the proposer's `proposal.retargeted` and the new reviewers' `proposal.needs_review`); A's reviewer
// loses access and leaves the review thread while B's reviewer and the proposer keep it; a
// `changes_requested` move stays in the proposer's turn; every refusal (403/404/409/422, a slug
// conflict named only when visible, an alias, restricted into global, members only); Move & accept
// in one transaction, rolled back whole by a refused gate; and the import's bulk actions skip a
// moved proposal. Data is committed under a per-run key; users are never deleted (append-only audit
// FKs); the global contribution policy is never touched (members only goes through `retargetInTx`).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess, Role } from "@skilly/shared";
import { pool } from "./db";
import { createProposal, getProposalDetail, materializeVersion, moveProposal, performProposalAction, type ProposalMetadata, type RevisionPayload } from "./proposals";
import { listMoveTargets, retargetInTx } from "./proposalRetarget";
import { inTransaction } from "./grants";
import { assignImport } from "./reviewAssign";
import { invalidateAccessCaches } from "./access";
import type { ArtifactStore } from "./objectStore";

const enabled = process.env.SKILLY_DB_E2E === "1";
const K = `rt${Date.now().toString(36)}`;

after(async () => {
  if (enabled) await pool.end();
});

const store = { delete: async () => {} } as unknown as ArtifactStore;
const access = (roles: [string, Role][] = [], isPlatformAdmin = false): EffectiveAccess => ({ isPlatformAdmin, namespaceRoles: new Map(roles) });

async function mkNs(slug: string, name: string): Promise<string> {
  return (await pool.query<{ id: string }>(`insert into namespaces (slug, display_name, require_review) values ($1, $2, true) returning id`, [slug, name])).rows[0]!.id;
}
async function mkUserIn(key: string, roles: [string, Role][]): Promise<string> {
  const user = (await pool.query<{ id: string }>(`insert into users (entra_object_id, email, display_name) values ($1, $2, $1) returning id`, [key, `${key}@org`])).rows[0]!.id;
  for (const [ns, role] of roles) {
    const g = (await pool.query<{ id: string }>(`insert into groups (entra_object_id, display_name) values ($1, $1) returning id`, [`${key}-${role}-${ns.slice(0, 8)}`])).rows[0]!.id;
    await pool.query(`insert into role_mappings (group_id, namespace_id, role) values ($1, $2, $3)`, [g, ns, role]);
    await pool.query(`insert into group_memberships (group_id, user_id) values ($1, $2)`, [g, user]);
  }
  return user;
}
async function row(id: string) {
  return (await pool.query<{ state: string; target_namespace_id: string; assignee_id: string | null; turn_started_at: Date; materialized_version_id: string | null }>(
    `select state, target_namespace_id, assignee_id, turn_started_at, materialized_version_id from proposals where id = $1`, [id],
  )).rows[0]!;
}
async function revisions(id: string) {
  return (await pool.query<{ revision_no: number; note: string | null; payload: RevisionPayload; author: string }>(
    `select revision_no, note, payload, author from proposal_revisions where proposal_id = $1 order by revision_no`, [id],
  )).rows;
}
async function notified(userId: string, type: string, proposalId: string) {
  return (await pool.query<{ payload: Record<string, unknown> }>(
    `select payload from notifications where user_id = $1 and type = $2 and payload->>'proposalId' = $3`, [userId, type, proposalId],
  )).rows;
}

test("§74 moving a new-skill proposal: targets, hand-off, access, refusals, Move & accept, imports", { skip: !enabled }, async () => {
  const A = await mkNs(`${K}-a`, "Team Alpha");
  const B = await mkNs(`${K}-b`, "Team Bravo");
  const C = await mkNs(`${K}-c`, "Team Charlie");
  const D = await mkNs(`${K}-d`, "Team Delta");
  const G = (await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`)).rows[0]!.id;
  // aAdmin reviews Alpha and belongs to Bravo and Charlie (so both are targets, neither reviewable).
  const aAdmin = await mkUserIn(`${K}-aadm`, [[A, "namespace_admin"], [B, "namespace_member"], [C, "namespace_member"]]);
  const bAdmin = await mkUserIn(`${K}-badm`, [[B, "namespace_admin"]]);
  const cAdmin = await mkUserIn(`${K}-cadm`, [[C, "namespace_admin"]]);
  const abAdmin = await mkUserIn(`${K}-abadm`, [[A, "namespace_admin"], [B, "namespace_admin"]]);
  const proposer = await mkUserIn(`${K}-prop`, [[A, "namespace_member"]]);
  const outsider = await mkUserIn(`${K}-out`, [[D, "namespace_member"]]);
  invalidateAccessCaches();
  const asAAdmin = access([[A, "namespace_admin"], [B, "namespace_member"], [C, "namespace_member"]]);
  const asBAdmin = access([[B, "namespace_admin"]]);
  const asABAdmin = access([[A, "namespace_admin"], [B, "namespace_admin"]]);
  const asProposer = access([[A, "namespace_member"]]);
  const asOutsider = access([[D, "namespace_member"]]);

  let n = 0;
  const propose = async (extra: Partial<ProposalMetadata> = {}, opts: { importId?: string } = {}) => {
    n += 1;
    const slug = `${K}-s${n}`;
    const key = `uploads/${proposer}/${K}-${n}.bundle`;
    await pool.query(`insert into scan_reports (subject_type, subject_id, scanner, status) values ('artifact', $1, 'test', 'scanned')`, [key]);
    const metadata: ProposalMetadata = { skillSlug: slug, title: `${K} ${n}`, description: "d", toolHarness: "generic", visibility: "namespace", categories: [], usageExamples: "u", sharedNamespaceIds: [], ...extra };
    const { id } = await createProposal(pool, {
      submittedByUserId: proposer, targetNamespaceId: A, targetSkillId: null, proposedSemver: "1.0.0",
      payload: { metadata, artifactObjectKey: key, artifactSha256: `s${n}`, contentSha256: `${K}-c${n}` },
      ...(opts.importId ? { importId: opts.importId } : {}),
    });
    return { id, slug, key };
  };
  const startReview = async (id: string, actor = aAdmin, as = asAAdmin) =>
    assert.ok((await performProposalAction(pool, { proposalId: id, action: "start_review", actorUserId: actor, access: as }, store)).ok);

  // ── 1. The targets: global plus the reviewer's own namespaces, minus the current one ──
  const p1 = await propose({ sharedNamespaceIds: [C] });
  const d1 = await getProposalDetail(pool, p1.id, asAAdmin, aAdmin);
  assert.deepEqual(new Set(d1!.moveTargets.map((t) => t.id)), new Set([G, B, C]));
  assert.equal(d1!.moveTargets.find((t) => t.id === B)!.canReview, false, "a member of Bravo doesn't review it");
  assert.equal((await getProposalDetail(pool, p1.id, asProposer, proposer))!.moveTargets.length, 0, "the proposer is offered no move");
  // Members only: just the proposer's namespaces (only Alpha, which is current) — nothing.
  assert.deepEqual(await listMoveTargets(pool, { access: asAAdmin, proposerAccess: asProposer, proposalsOpen: false, currentNamespaceId: A, slug: p1.slug }), []);

  // ── 2. The hand-off from under_review: Alpha → Bravo ──
  await startReview(p1.id);
  await pool.query(`update proposals set assignee_id = $2, assigned_by = $2 where id = $1`, [p1.id, aAdmin]);
  // aAdmin took part in the review thread and has an unread alert for it.
  const conv = (await pool.query<{ id: string }>(`insert into conversations (subject_type, subject_id) values ('proposal', $1) returning id`, [p1.id])).rows[0]!.id;
  await pool.query(`insert into conversation_participants (conversation_id, user_id) values ($1, $2), ($1, $3)`, [conv, aAdmin, proposer]);
  await pool.query(`insert into notifications (user_id, type, payload) values ($1, 'message.new', $2::jsonb)`, [aAdmin, JSON.stringify({ conversationId: conv, proposalId: p1.id })]);
  const before = await row(p1.id);
  const moved = await moveProposal(pool, { proposalId: p1.id, actorUserId: aAdmin, access: asAAdmin, targetNamespaceId: B, note: "Bravo owns this" });
  assert.deepEqual(moved, { ok: true, state: "proposed", targetNamespaceSlug: `${K}-b`, canRead: false });
  const after1 = await row(p1.id);
  assert.equal(after1.target_namespace_id, B);
  assert.equal(after1.state, "proposed", "nobody in Bravo has started a review");
  assert.equal(after1.assignee_id, null, "the assignee is cleared");
  assert.ok(after1.turn_started_at.getTime() >= before.turn_started_at.getTime(), "a fresh turn starts");
  const revs1 = await revisions(p1.id);
  assert.equal(revs1.length, 2);
  assert.equal(revs1[1]!.note, `Moved from @${K}-a to @${K}-b: Bravo owns this`);
  assert.equal(revs1[1]!.author, aAdmin);
  assert.deepEqual(new Set(revs1[1]!.payload.metadata.sharedNamespaceIds), new Set([A, C]), "Alpha joins the list; Bravo, the new owner, never does");
  const audit = (await pool.query<{ namespace_id: string; after: Record<string, unknown> }>(`select namespace_id, after from audit_log where action = 'proposal.retargeted' and target_id = $1`, [p1.id])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.namespace_id, A, "written under the namespace it left");
  assert.equal(audit[0]!.after.toNamespaceId, B);
  assert.equal(audit[0]!.after.via, "move");
  const told = await notified(proposer, "proposal.retargeted", p1.id);
  assert.equal(told.length, 1);
  assert.equal(told[0]!.payload.namespaceSlug, `${K}-b`);
  assert.equal(told[0]!.payload.fromNamespaceSlug, `${K}-a`);
  assert.equal(told[0]!.payload.note, "Bravo owns this");
  assert.equal((await notified(bAdmin, "proposal.needs_review", p1.id)).length, 1, "Bravo's reviewers are asked");
  // The review thread: aAdmin left it (and its unread alert); the proposer stays.
  const parts = (await pool.query<{ user_id: string }>(`select user_id from conversation_participants where conversation_id = $1`, [conv])).rows.map((r) => r.user_id);
  assert.deepEqual(parts, [proposer]);
  assert.equal((await pool.query(`select 1 from notifications where user_id = $1 and type = 'message.new' and payload->>'conversationId' = $2`, [aAdmin, conv])).rowCount, 0);
  // Who can read it now.
  assert.equal(await getProposalDetail(pool, p1.id, asAAdmin, aAdmin), null, "Alpha's reviewer lost access");
  assert.equal((await getProposalDetail(pool, p1.id, asBAdmin, bAdmin))!.targetNamespaceSlug, `${K}-b`);
  assert.ok(await getProposalDetail(pool, p1.id, asProposer, proposer), "the proposer keeps access");
  const again = await moveProposal(pool, { proposalId: p1.id, actorUserId: aAdmin, access: asAAdmin, targetNamespaceId: C });
  assert.equal(!again.ok && again.status, 404, "an outsider learns nothing");

  // ── 3. changes_requested stays in the proposer's turn ──
  const p2 = await propose({ visibility: "org", sharedNamespaceIds: undefined });
  await startReview(p2.id);
  assert.ok((await performProposalAction(pool, { proposalId: p2.id, action: "request_changes", actorUserId: aAdmin, access: asAAdmin, note: "fix it" }, store)).ok);
  const m2 = await moveProposal(pool, { proposalId: p2.id, actorUserId: aAdmin, access: asAAdmin, targetNamespaceId: C });
  assert.ok(m2.ok && m2.state === "changes_requested");
  assert.equal((await notified(cAdmin, "proposal.needs_review", p2.id)).length, 0, "nothing for Charlie until the resubmit");
  assert.equal((await notified(proposer, "proposal.retargeted", p2.id))[0]!.payload.state, "changes_requested");

  // ── 4. Refusals ──
  const p3 = await propose();
  const fail = async (input: Parameters<typeof moveProposal>[1], status: number, code?: string) => {
    const r = await moveProposal(pool, input);
    assert.equal(r.ok, false, JSON.stringify(input));
    if (!r.ok) {
      assert.equal(r.status, status, r.error);
      if (code) assert.equal(r.code, code);
    }
    return r;
  };
  await fail({ proposalId: p3.id, actorUserId: proposer, access: asProposer, targetNamespaceId: B }, 403);
  await fail({ proposalId: p3.id, actorUserId: outsider, access: asOutsider, targetNamespaceId: D }, 404);
  await fail({ proposalId: p3.id, actorUserId: aAdmin, access: asAAdmin, targetNamespaceId: D }, 422, "invalid_target_namespace");
  await fail({ proposalId: p3.id, actorUserId: aAdmin, access: asAAdmin, targetNamespaceId: A }, 422, "invalid_target_namespace");
  await fail({ proposalId: p3.id, actorUserId: aAdmin, access: asAAdmin, targetNamespaceId: "00000000-0000-4000-8000-000000000000" }, 422, "invalid_target_namespace");
  await fail({ proposalId: p3.id, actorUserId: aAdmin, access: asAAdmin, targetNamespaceId: G }, 422);
  assert.equal((await row(p3.id)).target_namespace_id, A, "a refused move changes nothing");
  // A visible same-slug skill in Charlie is named; an alias of a skill aAdmin can't see is not.
  const clashSlug = `${K}-clash`;
  await inTransaction(async (client) => {
    await materializeVersion(client, {
      targetNamespaceId: C, targetSkillId: null, semver: "1.0.0", submittedBy: cAdmin, actorUserId: cAdmin, via: "proposal_accept",
      payload: { metadata: { skillSlug: clashSlug, title: "clash", description: "d", toolHarness: "generic", visibility: "org", categories: [], usageExamples: "u" }, artifactObjectKey: `uploads/${cAdmin}/${K}-clash`, artifactSha256: "x", contentSha256: `${K}-cx` },
    });
  });
  const p4 = await propose({ skillSlug: clashSlug });
  const named = await fail({ proposalId: p4.id, actorUserId: aAdmin, access: asAAdmin, targetNamespaceId: C }, 409, "slug_exists_in_destination");
  assert.match(!named.ok ? named.error : "", new RegExp(`${K}-c/${clashSlug}`));
  assert.equal((await getProposalDetail(pool, p4.id, asAAdmin, aAdmin))!.moveTargets.find((t) => t.id === C)!.blocked, "slug_exists");
  const hiddenSlug = `${K}-hidden`;
  const hiddenSkill = await inTransaction(async (client) => (await materializeVersion(client, {
    targetNamespaceId: D, targetSkillId: null, semver: "1.0.0", submittedBy: outsider, actorUserId: outsider, via: "proposal_accept",
    payload: { metadata: { skillSlug: hiddenSlug, title: "hidden", description: "d", toolHarness: "generic", visibility: "namespace", categories: [], usageExamples: "u", sharedNamespaceIds: [] }, artifactObjectKey: `uploads/${outsider}/${K}-hidden`, artifactSha256: "y", contentSha256: `${K}-cy` },
  })).skillId);
  await pool.query(`insert into skill_path_aliases (namespace_id, slug, skill_id) values ($1, $2, $3)`, [C, hiddenSlug, hiddenSkill]);
  const p5 = await propose({ skillSlug: hiddenSlug });
  assert.equal((await getProposalDetail(pool, p5.id, asAAdmin, aAdmin))!.moveTargets.find((t) => t.id === C)!.blocked, null, "an invisible holder blocks nothing in the picker");
  const unnamed = await fail({ proposalId: p5.id, actorUserId: aAdmin, access: asAAdmin, targetNamespaceId: C }, 409, "slug_exists_in_destination");
  assert.equal(!unnamed.ok ? unnamed.error : "", `${hiddenSlug} isn't available in ${K}-c`);
  // Decided proposals don't move.
  const p6 = await propose();
  assert.ok((await performProposalAction(pool, { proposalId: p6.id, action: "reject", actorUserId: aAdmin, access: asAAdmin, note: "no" }, store)).ok);
  await fail({ proposalId: p6.id, actorUserId: aAdmin, access: asAAdmin, targetNamespaceId: B }, 409, "proposal_decided");
  // Members only, enforced on the server (through retargetInTx, so the platform setting stays put).
  const p7 = await propose();
  await inTransaction(async (client) => {
    const pr = (await client.query(`select id, state, target_namespace_id, target_skill_id, submitted_by, proposed_semver from proposals where id = $1 for update`, [p7.id])).rows[0];
    const r = await retargetInTx(client, {
      p: pr, access: asAAdmin, actorUserId: aAdmin, targetNamespaceId: B, keepState: false, via: "move",
      prep: { proposerAccess: asProposer, proposalsOpen: false, participants: [] },
    });
    assert.equal(!r.ok && r.code, "invalid_target_namespace", "the proposer can't propose into Bravo");
  });

  // ── 5. Move & accept: one transaction, all or nothing ──
  const p8 = await propose();
  await startReview(p8.id, abAdmin, asABAdmin);
  const onlyA = await performProposalAction(pool, { proposalId: p8.id, action: "accept", actorUserId: aAdmin, access: asAAdmin, expectedRevisionNo: 1, targetNamespaceId: B }, store);
  assert.equal(!onlyA.ok && onlyA.status, 403, "Move & accept needs a reviewer of both namespaces");
  const ok8 = await performProposalAction(pool, { proposalId: p8.id, action: "accept", actorUserId: abAdmin, access: asABAdmin, expectedRevisionNo: 1, targetNamespaceId: B, note: "ship it" }, store);
  assert.ok(ok8.ok && ok8.state === "accepted", JSON.stringify(ok8));
  const r8 = await row(p8.id);
  assert.equal(r8.target_namespace_id, B);
  const skill8 = (await pool.query<{ id: string; namespace_id: string }>(`select id, namespace_id from skills where slug = $1`, [p8.slug])).rows[0]!;
  assert.equal(skill8.namespace_id, B, "the skill is created in Bravo");
  assert.deepEqual((await pool.query<{ namespace_id: string }>(`select namespace_id from skill_namespace_grants where skill_id = $1`, [skill8.id])).rows.map((g) => g.namespace_id), [A], "shared with Alpha");
  assert.equal((await pool.query(`select 1 from audit_log where action = 'proposal.retargeted' and target_id = $1 and after->>'via' = 'move_accept'`, [p8.id])).rowCount, 1);
  assert.equal((await notified(proposer, "proposal.accept", p8.id))[0]!.payload.movedToNamespaceSlug, `${K}-b`);
  assert.equal((await notified(proposer, "proposal.retargeted", p8.id)).length, 0, "no separate move notice");
  assert.equal((await notified(bAdmin, "proposal.needs_review", p8.id)).length, 0, "nothing to review in Bravo");
  // A refused gate rolls back the move too.
  const p9 = await propose();
  await pool.query(`update scan_reports set severity = 'high', findings = '[{"scanner":"test","severity":"high","rule":"r","message":"m"}]'::jsonb where subject_id = $1`, [p9.key]);
  await startReview(p9.id, abAdmin, asABAdmin);
  const refused = await performProposalAction(pool, { proposalId: p9.id, action: "accept", actorUserId: abAdmin, access: asABAdmin, expectedRevisionNo: 1, targetNamespaceId: B }, store);
  assert.equal(!refused.ok && refused.status, 409);
  assert.equal((await row(p9.id)).target_namespace_id, A, "still in Alpha");
  assert.equal((await revisions(p9.id)).length, 1, "no move revision");
  assert.equal((await pool.query(`select 1 from audit_log where action = 'proposal.retargeted' and target_id = $1`, [p9.id])).rowCount, 0);

  // ── 6. Imports: a moved proposal leaves N and Assign all open ──
  const imp = (await pool.query<{ id: string }>(
    `insert into proposal_imports (submitted_by, target_namespace_id, origin_url, ref, mode) values ($1, $2, $3, 'main', 'review') returning id`,
    [proposer, A, `https://github.com/${K}/repo`],
  )).rows[0]!.id;
  const i1 = await propose({}, { importId: imp });
  const i2 = await propose({}, { importId: imp });
  assert.equal((await getProposalDetail(pool, i1.id, asAAdmin, aAdmin))!.import!.others, 1);
  assert.ok((await moveProposal(pool, { proposalId: i2.id, actorUserId: aAdmin, access: asAAdmin, targetNamespaceId: C })).ok);
  assert.equal((await getProposalDetail(pool, i1.id, asAAdmin, aAdmin))!.import!.others, 0, "the moved one left N");
  const assigned = await assignImport(pool, { importId: imp, assigneeId: aAdmin, access: asAAdmin, actorUserId: aAdmin });
  assert.ok(assigned.ok);
  assert.equal((await row(i1.id)).assignee_id, aAdmin);
  assert.equal((await row(i2.id)).assignee_id, null, "Assign all open skipped the moved proposal");
});
