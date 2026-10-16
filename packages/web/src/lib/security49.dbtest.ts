// §49 (October 2026 OWASP review, round 2) — DB integration tests for the web tier. Opt-in behind
// SKILLY_DB_E2E=1 (see admin.dbtest.ts for the run recipe; needs migrations through 0097):
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… node --import tsx --test src/lib/security49.dbtest.ts
// Covers: the fail-closed accept gate (409 scan_pending, audited override, the pinned commit and
// pre-scan digest riding into pending_mirrors), uniform 404 before any capability answer (§49.4),
// the quarantine release matrix (§49.2) and the owner-side `skill.shared` fan-out (§49.10).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess, Role } from "@skilly/shared";
import { pool } from "./db";
import { createProposal, performProposalAction, materializeVersion, promoteToGlobal, type ProposalMetadata, type RevisionPayload } from "./proposals";
import { setVersionYanked, setSkillArchived, releaseQuarantinedVersion } from "./manage";
import { addGrant, inTransaction } from "./grants";
import { addMaintainer } from "./maintainers";

const enabled = process.env.SKILLY_DB_E2E === "1";
const K = `s49${Date.now().toString(36)}`;
const COMMIT = "a".repeat(40);
const DIGEST = "b".repeat(64);

after(async () => {
  if (enabled) await pool.end();
});

const access = (roles: [string, Role][] = [], platform = false): EffectiveAccess => ({ isPlatformAdmin: platform, namespaceRoles: new Map(roles) });

async function mkNs(slug: string, name: string): Promise<string> {
  return (await pool.query<{ id: string }>(`insert into namespaces (slug, display_name, require_review) values ($1, $2, true) returning id`, [slug, name])).rows[0]!.id;
}
async function mkUserIn(key: string, ns: string | null, role: Role | null): Promise<string> {
  const user = (await pool.query<{ id: string }>(`insert into users (entra_object_id, email, display_name) values ($1, $2, $1) returning id`, [key, `${key}@org`])).rows[0]!.id;
  if (ns && role) {
    const g = (await pool.query<{ id: string }>(`insert into groups (entra_object_id, display_name) values ($1, $1) returning id`, [`${key}-grp`])).rows[0]!.id;
    await pool.query(`insert into role_mappings (group_id, namespace_id, role) values ($1, $2, $3)`, [g, ns, role]);
    await pool.query(`insert into group_memberships (group_id, user_id) values ($1, $2)`, [g, user]);
  }
  return user;
}
const meta = (slug: string, extra: Partial<ProposalMetadata> = {}): ProposalMetadata => ({
  skillSlug: slug, title: `${slug} title`, description: "restricted test skill", toolHarness: "generic",
  visibility: "namespace", categories: [], usageExamples: "u", ...extra,
});

test("§49.2 accept gate fails closed: 409 scan_pending, audited override, pin + digest reach pending_mirrors", { skip: !enabled }, async () => {
  const A = await mkNs(`${K}-ga`, "Gate Alpha");
  const admin = await mkUserIn(`${K}-gadm`, A, "namespace_admin");
  const proposer = await mkUserIn(`${K}-gpro`, A, "namespace_member");
  const reviewer = access([[A, "namespace_admin"]]);

  // A pointer proposal with no pre-scan report yet ⇒ the verdict is `pending`.
  const payload: RevisionPayload = { metadata: meta(`${K}-ptr`), pointer: { url: "https://github.com/example/skill.git", ref: "v1.0.0", subdir: null, commit: COMMIT } };
  const { id } = await createProposal(pool, { submittedByUserId: proposer, targetNamespaceId: A, proposedSemver: "1.0.0", payload });
  await performProposalAction(pool, { proposalId: id, action: "start_review", actorUserId: admin, access: reviewer });

  const blocked = await performProposalAction(pool, { proposalId: id, action: "accept", actorUserId: admin, access: reviewer, expectedRevisionNo: 1 });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.status, 409);
    assert.equal(blocked.scanPending, true);
    assert.equal(blocked.scanPendingReason, "pending");
    assert.equal(blocked.requiresOverride, true);
  }
  const noReason = await performProposalAction(pool, { proposalId: id, action: "accept", actorUserId: admin, access: reviewer, expectedRevisionNo: 1, override: true });
  assert.equal(noReason.ok, false);
  if (!noReason.ok) assert.equal(noReason.status, 422, "an override of a missing verdict needs a reason");

  // A scanned pre-scan with a content digest completes the verdict (no AV required: CLAMAV_HOST unset here).
  await pool.query(
    `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status, cached_for_ref, content_sha256)
     values ('proposal', $1, 'pointer-prescan', '[]'::jsonb, 'info', 'scanned', $2, $3)`,
    [id, `v1.0.0@${COMMIT}`, DIGEST],
  );
  const ok = await performProposalAction(pool, { proposalId: id, action: "accept", actorUserId: admin, access: reviewer, expectedRevisionNo: 1 });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const pm = (await pool.query<{ external_commit: string | null; prescan_content_sha256: string | null }>(
    `select pm.external_commit, pm.prescan_content_sha256 from pending_mirrors pm join skills s on s.id = pm.skill_id where s.slug = $1`, [`${K}-ptr`],
  )).rows[0];
  assert.deepEqual(pm, { external_commit: COMMIT, prescan_content_sha256: DIGEST }, "the pin and the pre-scan digest ride into the mirror queue");

  // A second proposal whose source MOVED: the verdict reads `changed`; an override with a reason is audited with the reason code.
  const payload2: RevisionPayload = { metadata: meta(`${K}-ptr2`), pointer: { url: "https://github.com/example/skill2.git", ref: "v2.0.0", subdir: null, commit: COMMIT } };
  const { id: id2 } = await createProposal(pool, { submittedByUserId: proposer, targetNamespaceId: A, proposedSemver: "1.0.0", payload: payload2 });
  await performProposalAction(pool, { proposalId: id2, action: "start_review", actorUserId: admin, access: reviewer });
  await pool.query(
    `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status, cached_for_ref)
     values ('proposal', $1, 'pointer-prescan', '[]'::jsonb, 'info', 'source_changed', $2)`,
    [id2, `v2.0.0@${COMMIT}`],
  );
  const moved = await performProposalAction(pool, { proposalId: id2, action: "accept", actorUserId: admin, access: reviewer, expectedRevisionNo: 1 });
  assert.equal(moved.ok, false);
  if (!moved.ok) assert.equal(moved.scanPendingReason, "changed");
  const forced = await performProposalAction(pool, { proposalId: id2, action: "accept", actorUserId: admin, access: reviewer, expectedRevisionNo: 1, override: true, overrideReason: "verified the new commit by hand" });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  const audit = (await pool.query<{ after: { missingVerdict?: string; reason?: string } }>(
    `select after from audit_log where action = 'proposal.scan_override' and target_id = $1 order by created_at desc limit 1`, [id2],
  )).rows[0];
  assert.equal(audit?.after.missingVerdict, "changed");
  assert.equal(audit?.after.reason, "verified the new commit by hand");
});

test("§49.4 visibility before everything: outsiders get 404 from manage/promote/release, members 403, admins proceed", { skip: !enabled }, async () => {
  const A = await mkNs(`${K}-va`, "Vis Alpha");
  const C = await mkNs(`${K}-vc`, "Vis Charlie");
  const admin = await mkUserIn(`${K}-vadm`, A, "namespace_admin");
  const skillId = await inTransaction(async (client) => {
    const r = await materializeVersion(client, {
      targetNamespaceId: A, targetSkillId: null, semver: "1.0.0", submittedBy: admin, actorUserId: admin, via: "proposal_accept",
      payload: { metadata: meta(`${K}-vis`), artifactObjectKey: `uploads/${admin}/v.bundle`, artifactSha256: "s", contentSha256: "c" },
    });
    return r.skillId;
  });
  const nsSlug = `${K}-va`;
  const slug = `${K}-vis`;
  const outsider = access([[C, "namespace_member"]]);
  const member = access([[A, "namespace_member"]]);
  const adminAccess = access([[A, "namespace_admin"]]);

  const o1 = await setVersionYanked(pool, { access: outsider, actorUserId: admin, namespaceSlug: nsSlug, skillSlug: slug, semver: "1.0.0", yanked: true });
  assert.deepEqual(o1, { ok: false, status: 404, error: "skill not found" }, "yank: outsider ⇒ 404, never 403");
  const o2 = await setSkillArchived(pool, { access: outsider, actorUserId: admin, namespaceSlug: nsSlug, skillSlug: slug, archived: true } as never);
  assert.equal((o2 as { status: number }).status, 404, "archive: outsider ⇒ 404");
  const o3 = await promoteToGlobal(pool, { access: outsider, actorUserId: admin, sourceNamespaceSlug: nsSlug, sourceSkillSlug: slug });
  assert.equal((o3 as { status: number }).status, 404, "promote: outsider ⇒ 404");
  const o4 = await releaseQuarantinedVersion(pool, { access: outsider, actorUserId: admin, namespaceSlug: nsSlug, skillSlug: slug, semver: "1.0.0", reason: "x" });
  assert.equal((o4 as { status: number }).status, 404, "release: outsider ⇒ 404");

  const m1 = await setVersionYanked(pool, { access: member, actorUserId: admin, namespaceSlug: nsSlug, skillSlug: slug, semver: "1.0.0", yanked: true });
  assert.equal((m1 as { status: number }).status, 403, "a member who can see it gets the real 403");

  // Release matrix (§49.2): a quarantined row; member 403, admin without reason 422, admin with reason ⇒ active + audited.
  await pool.query(
    `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, content_sha256, created_by, git_published)
     values ($1, '1.1.0', false, 'quarantined', $2, 'sq', 'cq', $3, false)`,
    [skillId, `pointers/${skillId}/v1.1.0.tgz`, admin],
  );
  await pool.query(
    `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status)
     values ('artifact', $1, 'pipeline', $2::jsonb, 'critical', 'scanned')`,
    [`pointers/${skillId}/v1.1.0.tgz`, JSON.stringify([{ scanner: "clamav", severity: "critical", rule: "malware", message: "Eicar-Test-Signature", path: "x" }])],
  );
  const r1 = await releaseQuarantinedVersion(pool, { access: member, actorUserId: admin, namespaceSlug: nsSlug, skillSlug: slug, semver: "1.1.0", reason: "ok" });
  assert.equal((r1 as { status: number }).status, 403);
  const r2 = await releaseQuarantinedVersion(pool, { access: adminAccess, actorUserId: admin, namespaceSlug: nsSlug, skillSlug: slug, semver: "1.1.0", reason: "  " });
  assert.equal((r2 as { status: number }).status, 422);
  const r3 = await releaseQuarantinedVersion(pool, { access: adminAccess, actorUserId: admin, namespaceSlug: nsSlug, skillSlug: slug, semver: "1.0.0", reason: "x" });
  assert.equal((r3 as { status: number }).status, 409, "an active version is not quarantined");
  const r4 = await releaseQuarantinedVersion(pool, { access: adminAccess, actorUserId: admin, namespaceSlug: nsSlug, skillSlug: slug, semver: "1.1.0", reason: "false positive, verified by hand" });
  assert.deepEqual(r4, { ok: true });
  const status = (await pool.query<{ status: string }>(`select status from skill_versions where skill_id = $1 and semver = '1.1.0'`, [skillId])).rows[0]!.status;
  assert.equal(status, "active");
  const rel = (await pool.query<{ after: { reason: string; findings: unknown[] } }>(
    `select after from audit_log where action = 'skill.version_released' and target_id = $1`, [`${skillId}@1.1.0`],
  )).rows[0];
  assert.equal(rel?.after.reason, "false positive, verified by hand");
  assert.equal(Array.isArray(rel?.after.findings) && rel!.after.findings.length, 1, "the findings that quarantined it are in the audit row");
});

test("§49.10 a maintainer-initiated share notifies the OWNING namespace's admins as well as the receiving ones", { skip: !enabled }, async () => {
  const A = await mkNs(`${K}-sa`, "Share Alpha");
  const B = await mkNs(`${K}-sb`, "Share Bravo");
  const aAdmin = await mkUserIn(`${K}-saadm`, A, "namespace_admin");
  const bAdmin = await mkUserIn(`${K}-sbadm`, B, "namespace_admin");
  const maintainer = await mkUserIn(`${K}-smnt`, A, "namespace_member");
  const slug = `${K}-shared`;
  const skillId = await inTransaction(async (client) => {
    const r = await materializeVersion(client, {
      targetNamespaceId: A, targetSkillId: null, semver: "1.0.0", submittedBy: aAdmin, actorUserId: aAdmin, via: "proposal_accept",
      payload: { metadata: meta(slug), artifactObjectKey: `uploads/${aAdmin}/s.bundle`, artifactSha256: "s", contentSha256: "c" },
    });
    return r.skillId;
  });
  assert.equal(await addMaintainer(aAdmin, { id: skillId, namespaceId: A, visibility: "namespace" } as never, maintainer), null);
  const added = await inTransaction((client) => addGrant(client, { id: skillId, namespaceId: A, visibility: "namespace" } as never, B, maintainer, "manage"));
  assert.equal(added, true);
  const notified = (await pool.query<{ user_id: string }>(
    `select user_id from notifications where type = 'skill.shared' and payload->>'skillSlug' = $1 order by user_id`, [slug],
  )).rows.map((r) => r.user_id).sort();
  assert.deepEqual(notified, [aAdmin, bAdmin].sort(), "owning-namespace admin AND receiving-namespace admin, not the acting maintainer");
});
