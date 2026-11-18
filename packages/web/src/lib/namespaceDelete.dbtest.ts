// Live-DB integration test for deleting a namespace (SKILLY_SPEC.md §71). Gated by SKILLY_DB_E2E=1:
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Covers: the request refusals (global, a mismatched slug, an over-long reason); the blockers (a live
// skill, an open proposal, a move waiting for the namespace as destination) and the preflight lists;
// the full delete of a namespace holding an archived skill, a moved-out skill with closed proposals,
// usage rows, an old address and a policy verdict + dismissal, a rejected new-skill proposal with its
// discussion, an incoming share with an explicit maintainer, an enabled marketplace with a token, a
// policy rule, two role mappings and an import — every effect, the audit trail, the admins'
// notification; the audit rows that outlive the namespace; a delete that finds a new blocker under
// the lock; and the slug released only once the disk purge is done.
// Data is committed under a per-run key; users are never deleted (append-only audit FKs), and the
// acting platform admin is a fixed upserted user.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Role } from "@skilly/shared";
import { pool } from "./db";
import { materializeVersion, type ProposalMetadata } from "./proposals";
import { inTransaction } from "./grants";
import { deleteNamespace, namespaceDeletionPreflight } from "./namespaceDelete";
import { createNamespace } from "./admin";
import { listAudit } from "./audit";

const enabled = process.env.SKILLY_DB_E2E === "1";
const K = `zqnsdel${Date.now().toString(36)}`;

after(async () => {
  if (enabled) await pool.end();
});

async function fixedActor(): Promise<string> {
  return (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ('zqnsdel-platform-admin', 'zqnsdel-platform-admin@org', 'Pat Platform')
     on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
  )).rows[0]!.id;
}
async function mkNs(slug: string, name = slug): Promise<string> {
  return (await pool.query<{ id: string }>(`insert into namespaces (slug, display_name, require_review) values ($1, $2, true) returning id`, [slug, name])).rows[0]!.id;
}
async function mkUserIn(key: string, roles: [string, Role][]): Promise<string> {
  const user = (await pool.query<{ id: string }>(`insert into users (entra_object_id, email, display_name) values ($1, $2, $1) returning id`, [key, `${key}@org`])).rows[0]!.id;
  for (const [ns, role] of roles) {
    const g = (await pool.query<{ id: string }>(`insert into groups (entra_object_id, display_name) values ($1, $1) returning id`, [`${key}-${role}`])).rows[0]!.id;
    await pool.query(`insert into role_mappings (group_id, namespace_id, role) values ($1, $2, $3)`, [g, ns, role]);
    await pool.query(`insert into group_memberships (group_id, user_id) values ($1, $2)`, [g, user]);
  }
  return user;
}
function meta(slug: string, extra: Partial<ProposalMetadata> = {}): ProposalMetadata {
  return { skillSlug: slug, title: `${slug} title`, description: "d", toolHarness: "generic", visibility: "namespace", categories: [], usageExamples: "u", sharedNamespaceIds: [], ...extra };
}
async function mkSkill(ns: string, slug: string, actor: string): Promise<{ skillId: string; versionId: string }> {
  return inTransaction(async (client) => {
    const r = await materializeVersion(client, {
      targetNamespaceId: ns, targetSkillId: null, semver: "1.0.0", submittedBy: actor, actorUserId: actor, via: "proposal_accept",
      payload: { metadata: meta(slug), artifactObjectKey: `uploads/${K}/${slug}.bundle`, artifactSha256: `${slug}-a`, contentSha256: `${slug}-c` },
    });
    return { skillId: r.skillId, versionId: r.versionId! };
  });
}
async function mkProposal(p: { target: string; skillId?: string | null; state: string; submittedBy: string; versionId?: string | null; destination?: string | null; slug: string }): Promise<string> {
  const id = (await pool.query<{ id: string }>(
    `insert into proposals (target_namespace_id, target_skill_id, proposed_semver, state, submitted_by, materialized_version_id, destination_namespace_id)
     values ($1, $2, '1.0.0', $3::proposal_state, $4, $5, $6) returning id`,
    [p.target, p.skillId ?? null, p.state, p.submittedBy, p.versionId ?? null, p.destination ?? null],
  )).rows[0]!.id;
  await pool.query(`insert into proposal_revisions (proposal_id, revision_no, author, payload) values ($1, 1, $2, $3::jsonb)`, [id, p.submittedBy, JSON.stringify({ metadata: meta(p.slug) })]);
  return id;
}
const exists = async (sql: string, params: unknown[]) => ((await pool.query(sql, params)).rowCount ?? 0) > 0;

test("§71 refusals: global, a mismatched slug, an over-long reason, an unknown id", { skip: !enabled }, async () => {
  const actor = await fixedActor();
  const global = (await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`)).rows[0]!.id;
  const g = await deleteNamespace(pool, global, { confirmSlug: "global", reason: null }, actor);
  assert.ok(!g.ok && g.status === 422 && g.code === "global_namespace");
  const gp = await namespaceDeletionPreflight(pool, global, actor);
  assert.ok(!gp.ok && gp.status === 422, "no preflight for global either");

  const ns = await mkNs(`${K}-ref`);
  const wrong = await deleteNamespace(pool, ns, { confirmSlug: `${K}-REF`, reason: null }, actor);
  assert.ok(!wrong.ok && wrong.status === 422 && wrong.code === "confirm_mismatch");
  const long = await deleteNamespace(pool, ns, { confirmSlug: `${K}-ref`, reason: "x".repeat(501) }, actor);
  assert.ok(!long.ok && long.status === 422 && long.code === "reason_too_long");
  assert.ok(await exists(`select 1 from namespaces where id = $1`, [ns]), "a refused delete changes nothing");

  const unknown = await deleteNamespace(pool, "00000000-0000-4000-8000-000000000000", { confirmSlug: "x", reason: null }, actor);
  assert.ok(!unknown.ok && unknown.status === 404);
  const garbage = await deleteNamespace(pool, "not-a-uuid", { confirmSlug: "x", reason: null }, actor);
  assert.ok(!garbage.ok && garbage.status === 404);
});

test("§71.2 blockers: a live skill, an open proposal, a move waiting for the namespace", { skip: !enabled }, async () => {
  const actor = await fixedActor();
  const proposer = await mkUserIn(`${K}-bprop`, []);

  // A live (active) skill blocks — so does a deprecated one; an archived one doesn't.
  const live = await mkNs(`${K}-live`);
  const { skillId } = await mkSkill(live, `${K}-live-s`, actor);
  let pre = await namespaceDeletionPreflight(pool, live, actor);
  assert.ok(pre.ok && !pre.preflight.deletable);
  assert.deepEqual(pre.ok && pre.preflight.blockers.skills.map((s) => s.slug), [`${K}-live-s`]);
  await pool.query(`update skills set deprecated_at = now() where id = $1`, [skillId]);
  const blocked = await deleteNamespace(pool, live, { confirmSlug: `${K}-live`, reason: null }, actor);
  assert.ok(!blocked.ok && blocked.status === 409 && blocked.code === "namespace_not_empty");
  assert.equal(!blocked.ok && blocked.blockers?.skills[0]?.deprecated, true);
  await pool.query(`update skills set status = 'archived' where id = $1`, [skillId]);
  pre = await namespaceDeletionPreflight(pool, live, actor);
  assert.ok(pre.ok && pre.preflight.deletable, "an archived skill doesn't block");
  assert.deepEqual(pre.ok && pre.preflight.effects.archivedSkills, [`${K}-live-s`]);

  // An open new-skill proposal blocks; once rejected it doesn't.
  const open = await mkNs(`${K}-open`);
  const pid = await mkProposal({ target: open, state: "under_review", submittedBy: proposer, slug: `${K}-open-s` });
  pre = await namespaceDeletionPreflight(pool, open, actor);
  assert.ok(pre.ok && !pre.preflight.deletable);
  assert.deepEqual(pre.ok && pre.preflight.blockers.proposals.map((p) => [p.id, p.title, p.state]), [[pid, `${K}-open-s title`, "under_review"]]);
  await pool.query(`update proposals set state = 'rejected' where id = $1`, [pid]);
  pre = await namespaceDeletionPreflight(pool, open, actor);
  assert.ok(pre.ok && pre.preflight.deletable && pre.preflight.effects.proposalsDeleted === 1);

  // A move waiting for the namespace to accept as destination blocks it.
  const src = await mkNs(`${K}-src`);
  const dest = await mkNs(`${K}-dest`);
  const moving = await mkSkill(src, `${K}-moving`, actor);
  const moveId = await mkProposal({ target: src, skillId: moving.skillId, state: "awaiting_destination", destination: dest, submittedBy: proposer, slug: `${K}-moving` });
  const d = await deleteNamespace(pool, dest, { confirmSlug: `${K}-dest`, reason: null }, actor);
  assert.ok(!d.ok && d.status === 409);
  assert.deepEqual(!d.ok && d.blockers?.proposals.map((p) => p.id), [moveId]);
});

test("§71.3 full delete: archived purge, history re-homed, shares/marketplace/rules/mappings removed, audit + notice", { skip: !enabled }, async () => {
  const actor = await fixedActor();
  const D = await mkNs(`${K}-d`, "Team Doomed");
  const O = await mkNs(`${K}-o`, "Team Owner");
  const G = await mkNs(`${K}-g`, "Team Granter");
  const dAdmin = await mkUserIn(`${K}-dadm`, [[D, "namespace_admin"]]);
  const dMember = await mkUserIn(`${K}-dmem`, [[D, "namespace_member"]]);
  const auditBefore = Number((await pool.query<{ n: string }>(`select count(*)::text as n from audit_log where namespace_id = $1`, [D])).rows[0]!.n);

  // An archived skill.
  const arch = await mkSkill(D, `${K}-arch`, actor);
  await pool.query(`update skills set status = 'archived' where id = $1`, [arch.skillId]);

  // A skill that moved out to O, leaving history behind: an accepted proposal (by version), a
  // rejected one (by skill), an accepted D → O move (re-homed to O: its destination must drop),
  // pre-move views, an old address, a policy verdict and a dismissal.
  const moved = await mkSkill(D, `${K}-moved`, actor);
  const accepted = await mkProposal({ target: D, state: "accepted", versionId: moved.versionId, submittedBy: dMember, slug: `${K}-moved` });
  const rejectedOld = await mkProposal({ target: D, skillId: moved.skillId, state: "rejected", submittedBy: dMember, slug: `${K}-moved` });
  const moveRecord = await mkProposal({ target: D, skillId: moved.skillId, state: "accepted", destination: O, submittedBy: dMember, slug: `${K}-moved` });
  await pool.query(`insert into usage_events (skill_id, namespace_id, actor_user_id) values ($1, $2, $3), ($1, $2, $3)`, [moved.skillId, D, dMember]);
  await pool.query(`update skills set namespace_id = $2 where id = $1`, [moved.skillId, O]);
  await pool.query(`insert into skill_path_aliases (namespace_id, slug, skill_id) values ($1, $2, $3)`, [D, `${K}-moved`, moved.skillId]);
  const rule = (await pool.query<{ id: string }>(`insert into policy_rules (scope, namespace_id, created_by) values ('namespace', $1, $2) returning id`, [D, actor])).rows[0]!.id;
  const rev = (await pool.query<{ id: string }>(`insert into policy_rule_revisions (rule_id, revision_no, title, body, author) values ($1, 1, 'No secrets', 'Never embed secrets.', $2) returning id`, [rule, actor])).rows[0]!.id;
  const run = (await pool.query<{ id: string }>(`insert into ai_prereviews (status, prompt_version, source, trigger) values ('done', 1, '{}'::jsonb, 'submit') returning id`)).rows[0]!.id;
  await pool.query(`insert into ai_prereview_policy_results (run_id, rule_id, revision_id, rule_state, outcome) values ($1, $2, $3, 'shadow', 'violates')`, [run, rule, rev]);
  await pool.query(
    `insert into policy_flag_dismissals (skill_id, semver, rule_id, revision_id, kind, reason, source, dismissed_by) values ($1, '1.0.0', $2, $3, 'false_positive', 'fine', 'manual', $4)`,
    [moved.skillId, rule, rev, actor],
  );

  // A rejected new-skill submission with a review discussion.
  const neverId = await mkProposal({ target: D, state: "rejected", submittedBy: dMember, slug: `${K}-never` });
  await pool.query(`insert into conversations (subject_type, subject_id) values ('proposal', $1)`, [neverId]);

  // A skill G shares into D, maintained explicitly by a D member (eligible only through the grant).
  const shared = await mkSkill(G, `${K}-shared`, actor);
  await pool.query(`insert into skill_namespace_grants (skill_id, namespace_id, granted_by) values ($1, $2, $3)`, [shared.skillId, D, actor]);
  await pool.query(`insert into skill_maintainers (skill_id, user_id, added_by) values ($1, $2, $3)`, [shared.skillId, dMember, actor]);

  // An enabled marketplace with a subscriber's token, and an import.
  await pool.query(`update namespaces set marketplace_enabled = true where id = $1`, [D]);
  await pool.query(
    `insert into tokens (user_id, type, hashed_token, marketplace_scope, namespace_id, scope, expires_at, is_system)
     values ($1, 'marketplace', $2, 'namespace', $3, '{}'::jsonb, now() + interval '30 days', false)`,
    [dMember, `${K}-mp-hash`, D],
  );
  const importId = (await pool.query<{ id: string }>(
    `insert into proposal_imports (submitted_by, target_namespace_id, origin_url, ref, mode) values ($1, $2, 'https://example.test/r.git', 'main', 'review') returning id`,
    [dMember, D],
  )).rows[0]!.id;
  await pool.query(`update proposals set import_id = $2 where id = $1`, [accepted, importId]);

  // ── The preflight states what will happen ──
  const pre = await namespaceDeletionPreflight(pool, D, actor);
  assert.ok(pre.ok && pre.preflight.deletable, "nothing blocks");
  if (!pre.ok) return;
  const e = pre.preflight.effects;
  assert.equal(e.archivedSkillsPurged, 1);
  assert.equal(e.proposalsRehomed, 3);
  assert.equal(e.proposalsDeleted, 1);
  assert.equal(e.usageRowsRehomed, 2);
  assert.equal(e.aliasesDropped, 1);
  assert.equal(e.grantsRevoked, 1);
  assert.equal(e.marketplaceEnabled, true);
  assert.equal(e.marketplaceTokensRevoked, 1);
  assert.equal(e.policyRulesDeleted, 1);
  assert.equal(e.roleMappingsRemoved, 2);
  assert.equal(e.importsRemoved, 1);
  assert.equal(e.adminsNotified, 1);

  // ── The delete ──
  const res = await deleteNamespace(pool, D, { confirmSlug: `${K}-d`, reason: "  Merged into Team Owner.  " }, actor);
  assert.ok(res.ok, `delete succeeds (${!res.ok ? res.error : ""})`);
  if (!res.ok) return;
  const { archivedSkills: _a, roleMappings: _r, ...expected } = e;
  assert.deepEqual(res.effects, expected, "the delete did exactly what the preflight said");

  assert.equal(await exists(`select 1 from namespaces where id = $1`, [D]), false, "the namespace row is gone");
  assert.equal(await exists(`select 1 from skills where id = $1`, [arch.skillId]), false, "the archived skill is purged");
  assert.ok(await exists(`select 1 from audit_log where action = 'skill.deleted' and target_id = $1`, [arch.skillId]));

  const homes = (await pool.query<{ id: string; target_namespace_id: string; destination_namespace_id: string | null }>(
    `select id, target_namespace_id, destination_namespace_id from proposals where id = any($1::uuid[])`, [[accepted, rejectedOld, moveRecord]],
  )).rows;
  assert.equal(homes.length, 3);
  for (const h of homes) assert.equal(h.target_namespace_id, O, "closed proposals of the moved skill now name its owner");
  assert.equal(homes.find((h) => h.id === moveRecord)!.destination_namespace_id, null, "the D → O move record loses its destination");
  assert.equal((await pool.query<{ import_id: string | null }>(`select import_id from proposals where id = $1`, [accepted])).rows[0]!.import_id, null, "the import link is cleared");
  assert.equal(await exists(`select 1 from proposal_imports where id = $1`, [importId]), false);
  assert.equal(Number((await pool.query<{ n: string }>(`select count(*)::text as n from usage_events where skill_id = $1 and namespace_id = $2`, [moved.skillId, O])).rows[0]!.n), 2, "views re-homed");

  assert.equal(await exists(`select 1 from proposals where id = $1`, [neverId]), false, "the rejected submission is deleted");
  assert.equal(await exists(`select 1 from conversations where subject_type = 'proposal' and subject_id = $1`, [neverId]), false, "with its discussion");
  assert.ok(await exists(`select 1 from audit_log where action = 'proposal.deleted' and target_id = $1`, [neverId]));

  assert.equal(await exists(`select 1 from skill_path_aliases where skill_id = $1`, [moved.skillId]), false, "the old address is dropped");
  assert.equal(await exists(`select 1 from skill_namespace_grants where skill_id = $1`, [shared.skillId]), false, "the incoming share is revoked");
  assert.ok(await exists(`select 1 from audit_log where action = 'skill.namespace_unshared' and target_id = $1 and after->>'via' = 'namespace_deleted'`, [shared.skillId]));
  assert.equal(await exists(`select 1 from skill_maintainers where skill_id = $1 and user_id = $2`, [shared.skillId, dMember]), false, "the maintainer who lost eligibility is pruned");
  assert.ok(await exists(`select 1 from audit_log where action = 'skill.maintainer_removed' and target_id = $1`, [shared.skillId]));
  assert.equal(await exists(`select 1 from tokens where hashed_token = $1`, [`${K}-mp-hash`]), false, "marketplace tokens are revoked");
  assert.ok(await exists(`select 1 from audit_log where action = 'namespace.marketplace_disabled' and namespace_id = $1 and (after->>'tokensRevoked')::int = 1`, [D]));
  assert.equal(await exists(`select 1 from policy_rules where id = $1`, [rule]), false, "the rule is deleted");
  assert.equal(await exists(`select 1 from ai_prereview_policy_results where rule_id = $1`, [rule]), false, "with its verdicts");
  assert.equal(await exists(`select 1 from policy_flag_dismissals where rule_id = $1`, [rule]), false, "and its dismissals");
  assert.ok(await exists(`select 1 from ai_prereviews where id = $1`, [run]), "the run itself stays");
  assert.ok(await exists(`select 1 from audit_log where action = 'policy.rule_deleted' and target_id = $1 and after->>'via' = 'namespace_deleted'`, [rule]));
  assert.equal(await exists(`select 1 from role_mappings where namespace_id = $1`, [D]), false, "role mappings are removed");
  assert.equal(Number((await pool.query<{ n: string }>(`select count(*)::text as n from audit_log where action = 'role_mapping.deleted' and before->>'namespace_id' = $1`, [D])).rows[0]!.n), 2);
  assert.ok(await exists(`select 1 from group_memberships gm join users u on u.id = gm.user_id where u.id = $1`, [dAdmin]), "the Entra groups and memberships stay");

  const purge = (await pool.query<{ relocations: { slug: string; skillId: string }[] }>(`select relocations from repo_disk_purges where namespace_slug = $1`, [`${K}-d`])).rows[0];
  assert.deepEqual(purge?.relocations, [{ slug: `${K}-moved`, skillId: moved.skillId }], "the disk purge is queued with the relocation");

  // The deletion record.
  const rec = (await pool.query<{ before: Record<string, unknown>; after: Record<string, unknown>; actor_user_id: string }>(
    `select before, after, actor_user_id from audit_log where action = 'namespace.deleted' and target_id = $1`, [D],
  )).rows[0]!;
  assert.equal(rec.actor_user_id, actor);
  assert.equal(rec.before.slug, `${K}-d`);
  assert.equal(rec.before.displayName, "Team Doomed");
  assert.equal((rec.before.roleMappings as unknown[]).length, 2);
  assert.equal(rec.after.reason, "Merged into Team Owner.");
  assert.equal(rec.after.proposalsRehomed, 3);
  assert.deepEqual([...(rec.after.rehomedProposalIds as string[])].sort(), [accepted, rejectedOld, moveRecord].sort());

  // The audit trail outlives the namespace, labelled from the snapshot.
  const auditAfter = Number((await pool.query<{ n: string }>(`select count(*)::text as n from audit_log where namespace_id = $1`, [D])).rows[0]!.n);
  assert.ok(auditAfter > auditBefore, "no audit row about the namespace was lost");
  const listed = await listAudit({ all: true, namespaceIds: [] }, { namespaceId: D, limit: 5 });
  assert.ok(listed.length > 0);
  for (const row of listed) {
    assert.equal(row.namespaceSlug, `${K}-d`);
    assert.equal(row.namespaceDeleted, true);
  }

  // The admins were told; the member and the actor were not.
  const notes = (await pool.query<{ user_id: string; payload: Record<string, unknown> }>(
    `select user_id, payload from notifications where type = 'namespace.deleted' and payload->>'namespaceSlug' = $1`, [`${K}-d`],
  )).rows;
  assert.deepEqual(notes.map((n) => n.user_id), [dAdmin]);
  assert.equal(notes[0]!.payload.reason, "Merged into Team Owner.");
  assert.equal(notes[0]!.payload.actorName, "Pat Platform");
  assert.equal(notes[0]!.payload.displayName, "Team Doomed");

  // §71.4: the slug is held until the worker has purged the disk, then released.
  const early = await createNamespace(pool, { slug: `${K}-d`, displayName: "Again", requireReview: true }, actor);
  assert.ok("error" in early && /still being removed/.test(early.error));
  await pool.query(`delete from repo_disk_purges where namespace_slug = $1`, [`${K}-d`]);
  const again = await createNamespace(pool, { slug: `${K}-d`, displayName: "Again", requireReview: true }, actor);
  assert.ok("id" in again && again.id !== D, "a new namespace with a new id takes the slug");
  assert.equal(await exists(`select 1 from skill_path_aliases where namespace_id = $1`, ["id" in again ? again.id : D]), false, "nothing of the old one carries over");
});

test("§71.3 step 1: a delete that finds a new blocker under the lock changes nothing", { skip: !enabled }, async () => {
  const actor = await fixedActor();
  const E = await mkNs(`${K}-race`);
  // An uncommitted skill insert holds a key-share lock on the namespace row (its FK check).
  const c1 = await pool.connect();
  try {
    await c1.query("begin");
    await materializeVersion(c1, {
      targetNamespaceId: E, targetSkillId: null, semver: "1.0.0", submittedBy: actor, actorUserId: actor, via: "proposal_accept",
      payload: { metadata: meta(`${K}-racer`), artifactObjectKey: `uploads/${K}/racer.bundle`, artifactSha256: "r-a", contentSha256: "r-c" },
    });
    const pending = deleteNamespace(pool, E, { confirmSlug: `${K}-race`, reason: null }, actor);
    await new Promise((r) => setTimeout(r, 300));
    await c1.query("commit");
    const res = await pending;
    assert.ok(!res.ok && res.status === 409, "the delete waited for the lock, then saw the new skill");
  } finally {
    c1.release();
  }
  assert.ok(await exists(`select 1 from namespaces where id = $1`, [E]));
  assert.equal(await exists(`select 1 from repo_disk_purges where namespace_slug = $1`, [`${K}-race`]), false, "nothing was queued");
});
