// Live-DB integration test for moving a skill to another namespace through a new-version proposal
// (SKILLY_SPEC.md §70). Gated by SKILLY_DB_E2E=1:
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Covers: the server-stamped source and the grant validation against the new owner; the owner-stage
// accept (no version, `awaiting_destination`, the approval recorded, the destination's reviewers
// asked); destination reviewers read nothing before it and decide (never edit) after it; a proposer
// revise returns it to the owner stage; the destination accept moves the skill (owner switch, alias,
// grants, `skill.moved` filtered by post-move visibility, audit) and re-routes the skill's other open
// proposals; a stale second move fails `skill_moved`; the alias reserves its slug (generic 409 + the
// DB trigger) and resolves to the canonical address; a destination conflict is named only to a
// reader who can see it; and a permitted direct publish moves the skill back, dropping the alias.
// Data is committed under a per-run key; users are never deleted (append-only audit FKs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess, Role } from "@skilly/shared";
import { pool } from "./db";
import {
  createProposal,
  directPublish,
  getProposalDetail,
  materializeVersion,
  performProposalAction,
  resolveReuseSource,
  applyReuseToPayload,
  verifySubmissionPayload,
  type ProposalMetadata,
  type RevisionPayload,
} from "./proposals";
import { inTransaction, listGrants } from "./grants";
import { destinationConflict, isSlugReserved, resolveSkillAlias } from "./skillMoves";
import { newSkillSlugClash } from "./duplicate";
import type { ArtifactStore } from "./objectStore";

const enabled = process.env.SKILLY_DB_E2E === "1";
const K = `mv${Date.now().toString(36)}`;

after(async () => {
  if (enabled) await pool.end();
});

const store = { delete: async () => {} } as unknown as ArtifactStore;
const access = (roles: [string, Role][] = [], isPlatformAdmin = false): EffectiveAccess => ({ isPlatformAdmin, namespaceRoles: new Map(roles) });

async function mkNs(slug: string, name: string, requireReview = true): Promise<string> {
  return (await pool.query<{ id: string }>(`insert into namespaces (slug, display_name, require_review) values ($1, $2, $3) returning id`, [slug, name, requireReview])).rows[0]!.id;
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
async function currentRevision(proposalId: string): Promise<number> {
  return (await pool.query<{ max: number }>(`select max(revision_no)::int as max from proposal_revisions where proposal_id = $1`, [proposalId])).rows[0]!.max;
}
async function proposalRow(id: string) {
  return (await pool.query<{ state: string; target_namespace_id: string; destination_namespace_id: string | null; owner_accepted_by: string | null; owner_accepted_revision: number | null; materialized_version_id: string | null }>(
    `select state, target_namespace_id, destination_namespace_id, owner_accepted_by, owner_accepted_revision, materialized_version_id from proposals where id = $1`, [id],
  )).rows[0]!;
}

test("§70 moving a skill: two-stage accept, aliases, re-routing, reservation, move back", { skip: !enabled }, async () => {
  const A = await mkNs(`${K}-a`, "Team Alpha");
  const B = await mkNs(`${K}-b`, "Team Bravo");
  const C = await mkNs(`${K}-c`, "Team Charlie");
  const aAdmin = await mkUserIn(`${K}-aadm`, [[A, "namespace_admin"]]);
  const bAdmin = await mkUserIn(`${K}-badm`, [[B, "namespace_admin"]]);
  const proposer = await mkUserIn(`${K}-prop`, [[A, "namespace_member"]]);
  const outsider = await mkUserIn(`${K}-out`, [[C, "namespace_member"]]);
  const asAAdmin = access([[A, "namespace_admin"]]);
  const asBAdmin = access([[B, "namespace_admin"]]);
  const asProposer = access([[A, "namespace_member"]]);
  const asOutsider = access([[C, "namespace_member"]]);
  const slug = `${K}-skill`;

  // A restricted skill in Alpha, shared with nobody, v1.0.0 live.
  const meta: ProposalMetadata = { skillSlug: slug, title: `${K} Movable`, description: "a skill that moves", toolHarness: "generic", visibility: "namespace", categories: [], usageExamples: "u", sharedNamespaceIds: [] };
  const key = `uploads/${aAdmin}/${K}.bundle`;
  const skillId = await inTransaction(async (client) => {
    const r = await materializeVersion(client, {
      targetNamespaceId: A, targetSkillId: null, semver: "1.0.0", submittedBy: aAdmin, actorUserId: aAdmin, via: "proposal_accept",
      payload: { metadata: meta, artifactObjectKey: key, artifactSha256: "s1", contentSha256: `${K}-c1` },
    });
    await client.query(`update skill_versions set git_published = true where skill_id = $1`, [r.skillId]);
    return r.skillId;
  });
  await pool.query(`insert into scan_reports (subject_type, subject_id, scanner, status) values ('artifact', $1, 'test', 'scanned')`, [key]);
  // A watcher in Alpha who will keep access through the old owner's grant.
  await pool.query(`insert into skill_watches (skill_id, user_id) values ($1, $2) on conflict do nothing`, [skillId, proposer]);

  // ── 1. Submit: the destination is validated, the source server-stamped, grants checked against the NEW owner ──
  const movePayload = async (dest: string, extra: Partial<ProposalMetadata> = {}): Promise<RevisionPayload> => {
    const p: RevisionPayload = { metadata: { ...meta, whatChanged: "Updated metadata", destinationNamespaceId: dest, sharedNamespaceIds: [A], sourceNamespaceId: "forged", ...extra } };
    const err = await verifySubmissionPayload(pool, proposer, p, { namespaceSlug: `${K}-a`, targetSkillId: skillId, access: asProposer });
    assert.equal(err, null, `payload verifies (${err})`);
    const r = await resolveReuseSource(pool, asProposer, skillId, p.metadata);
    assert.ok(r.ok, "a namespace change alone satisfies the no-op guard");
    return applyReuseToPayload(p, r.ok ? r.reuse : (null as never));
  };
  const p1 = await movePayload(B);
  assert.equal(p1.metadata.sourceNamespaceId, A, "the source is stamped by the server, never trusted");
  assert.deepEqual(p1.metadata.sharedNamespaceIds, [A], "the old owner may be a grantee of a moved skill");
  const toGlobal: RevisionPayload = { metadata: { ...meta, whatChanged: "w", destinationNamespaceId: (await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`)).rows[0]!.id } };
  assert.match((await verifySubmissionPayload(pool, proposer, toGlobal, { targetSkillId: skillId, access: asProposer })) ?? "", /global/);
  const toOwner: RevisionPayload = { metadata: { ...meta, whatChanged: "w", destinationNamespaceId: A } };
  assert.equal(await verifySubmissionPayload(pool, proposer, toOwner, { targetSkillId: skillId, access: asProposer }), null);
  assert.equal(toOwner.metadata.destinationNamespaceId, null, "picking the owner again is no move");

  const { id: moveId } = await createProposal(pool, { submittedByUserId: proposer, targetNamespaceId: A, targetSkillId: skillId, proposedSemver: "1.0.1", payload: p1 });
  assert.equal((await proposalRow(moveId)).destination_namespace_id, B, "the column mirrors the revision");
  // A second, non-move proposal and a competing move (to Charlie), both open when the first one lands.
  const plainReuse = await resolveReuseSource(pool, asProposer, skillId);
  if (!plainReuse.ok) throw new Error(plainReuse.error);
  const { id: plainId } = await createProposal(pool, {
    submittedByUserId: proposer, targetNamespaceId: A, targetSkillId: skillId, proposedSemver: "1.0.2",
    payload: applyReuseToPayload({ metadata: { ...meta, title: `${K} Retitled`, whatChanged: "retitle" } }, plainReuse.reuse),
  });
  const { id: staleId } = await createProposal(pool, { submittedByUserId: proposer, targetNamespaceId: A, targetSkillId: skillId, proposedSemver: "1.0.3", payload: await movePayload(C) });

  // ── 2. Owner stage: the destination can't see or act on it yet ──
  assert.equal(await getProposalDetail(pool, moveId, asBAdmin, bAdmin), null, "destination reviewers read nothing before the owner accepts");
  assert.ok((await performProposalAction(pool, { proposalId: moveId, action: "start_review", actorUserId: aAdmin, access: asAAdmin }, store)).ok);
  const early = await performProposalAction(pool, { proposalId: moveId, action: "accept", actorUserId: bAdmin, access: asBAdmin, expectedRevisionNo: 1 }, store);
  assert.equal(early.ok, false, "the destination can't accept at the owner stage");

  const ownerOk = await performProposalAction(pool, { proposalId: moveId, action: "accept", actorUserId: aAdmin, access: asAAdmin, expectedRevisionNo: 1 }, store);
  assert.ok(ownerOk.ok && ownerOk.state === "awaiting_destination", "the owner's accept waits for the destination");
  let row = await proposalRow(moveId);
  assert.equal(row.materialized_version_id, null, "nothing is published at the owner stage");
  assert.equal(row.owner_accepted_by, aAdmin);
  assert.equal(row.owner_accepted_revision, 1);
  assert.equal((await pool.query(`select 1 from skill_versions where skill_id = $1 and semver = '1.0.1'`, [skillId])).rowCount, 0);
  assert.equal((await pool.query(`select 1 from notifications where user_id = $1 and type = 'proposal.needs_review' and payload->>'proposalId' = $2`, [bAdmin, moveId])).rowCount, 1, "the destination's reviewers are asked");
  assert.equal((await pool.query(`select 1 from notifications where user_id = $1 and type = 'proposal.owner_accepted' and payload->>'proposalId' = $2`, [proposer, moveId])).rowCount, 1, "the proposer is told");
  assert.equal((await pool.query(`select 1 from audit_log where action = 'proposal.owner_accepted' and target_id = $1`, [moveId])).rowCount, 1);

  // ── 3. Destination stage: read + decide, never edit; the owner can no longer act ──
  const destView = await getProposalDetail(pool, moveId, asBAdmin, bAdmin);
  assert.ok(destView, "destination reviewers read it from the owner's accept on");
  assert.equal(destView!.caps.isReviewer, true);
  assert.equal(destView!.caps.canEdit, false);
  assert.equal(destView!.destination?.id, B);
  assert.equal((await getProposalDetail(pool, moveId, asAAdmin, aAdmin))!.caps.isReviewer, false, "the owner's reviewers can't act at the destination stage");
  const destEdit = await performProposalAction(pool, {
    proposalId: moveId, action: "accept", actorUserId: bAdmin, access: asBAdmin, expectedRevisionNo: 1,
    newPayload: { ...p1, metadata: { ...p1.metadata, title: "hijack" } },
  }, store);
  assert.equal(destEdit.ok, false, "the destination never edits");

  // ── 4. A proposer revise returns it to the owner stage ──
  const revised = await performProposalAction(pool, {
    proposalId: moveId, action: "revise", actorUserId: proposer, access: asProposer,
    newPayload: { ...p1, metadata: { ...p1.metadata, title: `${K} Moved` } },
  }, store);
  assert.ok(revised.ok && revised.state === "under_review", "a revise sends it back to the owner");
  row = await proposalRow(moveId);
  assert.equal(row.owner_accepted_by, null, "the owner approval is cleared");
  assert.equal(await getProposalDetail(pool, moveId, asBAdmin, bAdmin), null, "and the destination loses read access again");
  assert.ok((await performProposalAction(pool, { proposalId: moveId, action: "accept", actorUserId: aAdmin, access: asAAdmin, expectedRevisionNo: 2 }, store)).ok);

  // ── 5. The destination accepts: the skill moves ──
  const final = await performProposalAction(pool, { proposalId: moveId, action: "accept", actorUserId: bAdmin, access: asBAdmin, expectedRevisionNo: 2 }, store);
  assert.ok(final.ok && final.state === "accepted", `the destination's accept publishes (${!final.ok ? final.error : ""})`);
  const skill = (await pool.query<{ namespace_id: string; title: string }>(`select namespace_id, title from skills where id = $1`, [skillId])).rows[0]!;
  assert.equal(skill.namespace_id, B, "the skill now lives in Bravo");
  assert.equal(skill.title, `${K} Moved`, "with the revised metadata");
  assert.ok((await pool.query(`select 1 from skill_versions where skill_id = $1 and semver = '1.0.1'`, [skillId])).rowCount, "v1.0.1 is published");
  assert.deepEqual((await listGrants(skillId)).map((g) => g.displayName), ["Team Alpha"], "the old owner keeps access as a grantee");
  assert.equal((await pool.query<{ skill_id: string }>(`select skill_id from skill_path_aliases where namespace_id = $1 and slug = $2`, [A, slug])).rows[0]?.skill_id, skillId, "the old address is an alias");
  const moved = (await pool.query<{ after: { namespaceId: string; reroutedProposalIds: string[] } }>(`select after from audit_log where action = 'skill.moved' and target_id = $1`, [skillId])).rows;
  assert.equal(moved.length, 1);
  assert.equal(moved[0]!.after.namespaceId, B);
  assert.deepEqual([...moved[0]!.after.reroutedProposalIds].sort(), [plainId, staleId].sort(), "the other open proposals were re-routed");
  const recipients = (await pool.query<{ user_id: string; payload: { oldNamespaceSlug: string; semver: string } }>(`select user_id, payload from notifications where type = 'skill.moved' and payload->>'skillId' = $1`, [skillId])).rows;
  const ids = new Set(recipients.map((r) => r.user_id));
  assert.ok(ids.has(aAdmin), "the old owner's admin is told");
  assert.ok(ids.has(proposer), "a watcher who still sees it is told");
  assert.ok(!ids.has(bAdmin), "the actor is not");
  assert.ok(!ids.has(outsider), "nobody who can't see the skill");
  assert.equal(recipients[0]!.payload.oldNamespaceSlug, `${K}-a`);
  assert.equal(recipients[0]!.payload.semver, "1.0.1");

  // ── 6. Re-routed proposals: the plain one is the new owner's; the stale move fails `skill_moved` ──
  assert.equal((await proposalRow(plainId)).target_namespace_id, B, "re-routed to the new owner");
  assert.equal((await proposalRow(staleId)).target_namespace_id, B);
  assert.ok((await performProposalAction(pool, { proposalId: staleId, action: "start_review", actorUserId: bAdmin, access: asBAdmin }, store)).ok);
  const stale = await performProposalAction(pool, { proposalId: staleId, action: "accept", actorUserId: bAdmin, access: asBAdmin, expectedRevisionNo: await currentRevision(staleId) }, store);
  assert.equal(!stale.ok && stale.code, "skill_moved", "a move written against the old owner can't be accepted");

  // ── 7. The alias: resolution, reservation, the DB trigger ──
  const canonical = await resolveSkillAlias(`${K}-a`, slug);
  assert.deepEqual(canonical, { skillId, namespaceSlug: `${K}-b`, slug }, "the old address resolves to the canonical one");
  assert.equal(await resolveSkillAlias(`${K}-c`, slug), null);
  assert.equal(await isSlugReserved(pool, A, slug), true);
  const clash = await newSkillSlugClash(asOutsider, A, slug);
  assert.equal(clash?.status, 409, "a new skill can't take a reserved slug");
  const body = (await clash!.json()) as { error: string; code: string };
  assert.equal(body.code, "slug_reserved");
  assert.ok(!body.error.includes(`${K}-b`), "the refusal names no skill");
  await assert.rejects(
    pool.query(`insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility) values ($1, $2, 't', 'd', 'generic', 'hosted', 'org')`, [A, slug]),
    /reserved/,
    "the trigger backs the reservation",
  );

  // ── 8. A destination conflict is named only to a reader who can see it ──
  const other = await inTransaction(async (client) => (await materializeVersion(client, {
    targetNamespaceId: C, targetSkillId: null, semver: "1.0.0", submittedBy: outsider, actorUserId: outsider, via: "proposal_accept",
    payload: { metadata: { ...meta, title: "Charlie copy" }, artifactObjectKey: `uploads/${outsider}/${K}-c.bundle`, artifactSha256: "s2", contentSha256: `${K}-c2` },
  })).skillId);
  const seen = await destinationConflict(pool, asOutsider, { skillId, slug, destinationNamespaceId: C });
  assert.ok(seen?.kind === "skill" && seen.visible, "named to a reader who can see Charlie's skill");
  const unseen = await destinationConflict(pool, asBAdmin, { skillId, slug, destinationNamespaceId: C });
  assert.ok(unseen?.kind === "skill" && !unseen.visible, "not named to one who can't");
  assert.equal((await destinationConflict(pool, null, { skillId: other, slug, destinationNamespaceId: A }))?.kind, "alias", "Alpha's alias blocks a different skill");

  // ── 9. A permitted direct publish moves it back; the alias at the destination goes away ──
  const platform = await mkUserIn(`${K}-plat`, []);
  const asPlatform = access([], true);
  const backMeta = { ...meta, title: `${K} Moved`, whatChanged: "back home", destinationNamespaceId: A, sharedNamespaceIds: [] as string[] };
  const back: RevisionPayload = { metadata: backMeta };
  assert.equal(await verifySubmissionPayload(pool, platform, back, { namespaceSlug: `${K}-b`, targetSkillId: skillId, access: asPlatform }), null);
  const reuse = await resolveReuseSource(pool, asPlatform, skillId, back.metadata);
  assert.ok(reuse.ok);
  const pub = await directPublish(pool, { access: asPlatform, actorUserId: platform, namespaceSlug: `${K}-b`, semver: "1.1.0", payload: applyReuseToPayload(back, reuse.ok ? reuse.reuse : (null as never)) });
  assert.ok(pub.ok && !("routed" in pub), `a platform admin's publish moves at once (${!pub.ok ? pub.error : ""})`);
  assert.equal((await pool.query<{ namespace_id: string }>(`select namespace_id from skills where id = $1`, [skillId])).rows[0]!.namespace_id, A, "home again");
  assert.equal(await isSlugReserved(pool, A, slug), false, "the alias at the destination is gone");
  assert.equal((await pool.query<{ skill_id: string }>(`select skill_id from skill_path_aliases where namespace_id = $1 and slug = $2`, [B, slug])).rows[0]?.skill_id, skillId, "Bravo's address is now the alias");

  // ── 10. A member who can't publish into the destination is routed to its reviewers ──
  const aPub = await mkUserIn(`${K}-apub`, [[A, "namespace_admin"]]);
  const routedPayload: RevisionPayload = { metadata: { ...meta, title: `${K} Moved`, whatChanged: "to charlie", destinationNamespaceId: B, sharedNamespaceIds: [] } };
  assert.equal(await verifySubmissionPayload(pool, aPub, routedPayload, { namespaceSlug: `${K}-a`, targetSkillId: skillId, access: asAAdmin }), null);
  const r2 = await resolveReuseSource(pool, asAAdmin, skillId, routedPayload.metadata);
  const routed = await directPublish(pool, { access: asAAdmin, actorUserId: aPub, namespaceSlug: `${K}-a`, semver: "1.2.0", payload: applyReuseToPayload(routedPayload, r2.ok ? r2.reuse : (null as never)) });
  assert.ok(routed.ok && "routed" in routed && routed.routedReason === "namespace_move", "routed for the destination side");
  const routedRow = await proposalRow((routed as { proposalId: string }).proposalId);
  assert.equal(routedRow.state, "awaiting_destination", "the publisher's own publish stands for the owner's approval");
  assert.equal(routedRow.owner_accepted_by, aPub);
});
