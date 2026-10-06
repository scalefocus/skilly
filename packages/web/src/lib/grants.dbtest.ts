// Live-DB integration test for sharing a restricted skill with other namespaces (SKILLY_SPEC.md
// §42). Gated by SKILLY_DB_E2E=1:
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Covers: grants created at accept (audit `via`, `skill.shared` to the receiving admins only),
// invariant #3 through the catalog (grantee member sees it with the marker, outsider never does,
// namespace view includes it), target validation + the guard trigger, the payload validation and
// both no-op guards treating a grant diff as a real change, maintainer eligibility via a grant and
// the prune-on-revoke rule, the re-version sync (direct publish), and the namespace marketplace
// counts. Data is committed (the catalog reads through the pool) under a per-run key.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess, Role } from "@skilly/shared";
import { pool } from "./db";
import { materializeVersion, resolveReuseSource, verifySubmissionPayload, type ProposalMetadata } from "./proposals";
import { listGrants, removeGrant, inTransaction, validateGrantTargets } from "./grants";
import { searchSkills } from "./catalog";
import { addMaintainer } from "./maintainers";
import { marketplaceSkillCount } from "./marketplaces";

const enabled = process.env.SKILLY_DB_E2E === "1";
const K = `shr${Date.now().toString(36)}`;

after(async () => {
  if (enabled) await pool.end();
});

const access = (roles: [string, Role][] = []): EffectiveAccess => ({ isPlatformAdmin: false, namespaceRoles: new Map(roles) });

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

test("§42 sharing: grants, visibility, guards, maintainers, re-version sync, marketplaces", { skip: !enabled }, async () => {
  const A = await mkNs(`${K}-a`, "Team Alpha");
  const B = await mkNs(`${K}-b`, "Team Bravo");
  const C = await mkNs(`${K}-c`, "Team Charlie");
  const globalId = (await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`)).rows[0]!.id;
  const aAdmin = await mkUserIn(`${K}-aadm`, A, "namespace_admin");
  const bAdmin = await mkUserIn(`${K}-badm`, B, "namespace_admin");
  const bMember = await mkUserIn(`${K}-bmem`, B, "namespace_member");
  const cMember = await mkUserIn(`${K}-cmem`, C, "namespace_member");

  const meta: ProposalMetadata = {
    skillSlug: `${K}-skill`, title: `${K} Shared Skill`, description: "restricted skill shared with bravo",
    toolHarness: "generic", visibility: "namespace", categories: [], usageExamples: "u1", sharedNamespaceIds: [B],
  };

  // ── 1. New skill accepted with an initial grant ──────────────────────────────────────────
  const skillId = await inTransaction(async (client) => {
    const r = await materializeVersion(client, {
      targetNamespaceId: A, targetSkillId: null, semver: "1.0.0", submittedBy: aAdmin, actorUserId: aAdmin, via: "proposal_accept",
      payload: { metadata: meta, artifactObjectKey: `uploads/${aAdmin}/x.bundle`, artifactSha256: "s1", contentSha256: "c1" },
    });
    await client.query(`update skill_versions set git_published = true where skill_id = $1`, [r.skillId]);
    return r.skillId;
  });
  assert.deepEqual((await listGrants(skillId)).map((g) => g.displayName), ["Team Bravo"], "initial grant created at accept");
  const shareAudit = (await pool.query<{ after: { namespaceId: string; via: string } }>(
    `select after from audit_log where action = 'skill.namespace_shared' and target_id = $1`, [skillId],
  )).rows;
  assert.deepEqual(shareAudit.map((r) => r.after), [{ namespaceId: B, via: "proposal_accept" }], "share audited with via");
  const sharedNotified = (await pool.query<{ user_id: string }>(`select user_id from notifications where type = 'skill.shared' and payload->>'skillSlug' = $1`, [meta.skillSlug])).rows.map((r) => r.user_id);
  assert.deepEqual(sharedNotified, [bAdmin], "skill.shared reaches the RECEIVING namespace's admins only");

  // ── 2. Invariant #3 through the catalog ──────────────────────────────────────────────────
  const find = async (a: EffectiveAccess, ns?: string) =>
    (await searchSkills(a, { q: K, namespaceSlug: ns ?? null, limit: 50 })).find((s) => s.skillSlug === meta.skillSlug);
  const bView = await find(access([[B, "namespace_member"]]));
  assert.ok(bView, "a grantee-namespace member sees the shared skill");
  assert.equal(bView!.sharedFrom, "Team Alpha", "…with the 'Shared with your namespace by' marker");
  assert.equal((await find(access([[A, "namespace_member"]])))?.sharedFrom, null, "owner members see no marker");
  assert.equal(await find(access([[C, "namespace_member"]])), undefined, "an outsider never sees it (invariant #3)");
  assert.equal(await find(access()), undefined, "a user with no namespaces never sees it");
  assert.ok(await find(access([[B, "namespace_member"]]), `${K}-b`), "the grantee namespace's catalog view includes it");
  assert.equal(await find(access([[C, "namespace_member"]]), `${K}-b`), undefined, "the namespace view still applies visibility");

  // ── 3. Target validation + the guard trigger ─────────────────────────────────────────────
  const v1 = await validateGrantTargets(pool, A, [A]);
  assert.equal(!v1.ok && v1.error, "owner_namespace");
  const v2 = await validateGrantTargets(pool, A, [globalId]);
  assert.equal(!v2.ok && v2.error, "global_namespace");
  const v3 = await validateGrantTargets(pool, A, ["00000000-0000-0000-0000-000000000000"]);
  assert.equal(!v3.ok && v3.error, "unknown_namespace");
  const v4 = await validateGrantTargets(pool, A, [C, B, C]);
  assert.ok(v4.ok && v4.ids.length === 2, "valid targets de-duplicated");
  await assert.rejects(pool.query(`insert into skill_namespace_grants (skill_id, namespace_id) values ($1, $2)`, [skillId, A]), /owning namespace/);
  await assert.rejects(pool.query(`insert into skill_namespace_grants (skill_id, namespace_id) values ($1, $2)`, [skillId, globalId]), /global/);

  // ── 4. Payload validation: normalized for a restricted target, cleared for an org one ────
  const payload = { metadata: { ...meta, whatChanged: "w", sharedNamespaceIds: [C, B, C] } };
  assert.equal(await verifySubmissionPayload(pool, aAdmin, payload, { targetSkillId: skillId, namespaceSlug: `${K}-a` }), null);
  assert.deepEqual(payload.metadata.sharedNamespaceIds, [B, C].sort(), "de-duplicated + sorted");
  const bad = { metadata: { ...meta, whatChanged: "w", sharedNamespaceIds: [A] } };
  assert.match((await verifySubmissionPayload(pool, aAdmin, bad, { targetSkillId: skillId })) ?? "", /own namespace/);
  const orgNew = { metadata: { ...meta, skillSlug: `${K}-org`, visibility: "org" as const, sharedNamespaceIds: [B] } };
  assert.equal(await verifySubmissionPayload(pool, aAdmin, orgNew, { namespaceSlug: `${K}-a` }), null);
  assert.deepEqual(orgNew.metadata.sharedNamespaceIds, [], "an org skill carries no grants");

  // ── 5. The reuse no-op guard counts a grant diff as a real change ─────────────────────────
  const same = await resolveReuseSource(pool, skillId, { ...meta, sharedNamespaceIds: [B] });
  assert.equal(same.ok, false, "unchanged grants + metadata → nothing changed");
  const widened = await resolveReuseSource(pool, skillId, { ...meta, sharedNamespaceIds: [B, C] });
  assert.equal(widened.ok, true, "'also share with Charlie' alone is a valid re-version");

  // ── 6. Maintainer eligibility via a grant, pruned on revoke ──────────────────────────────
  const skillRef = { id: skillId, namespaceId: A, visibility: "namespace" as const };
  assert.equal(await addMaintainer(aAdmin, skillRef, bMember), null, "a grantee member is eligible to maintain");
  assert.ok(await addMaintainer(aAdmin, skillRef, cMember), "an outsider is not");
  const revoked = await inTransaction((client) => removeGrant(client, skillRef, B, bAdmin, "manage"));
  assert.equal(revoked.removed, true);
  assert.deepEqual(revoked.prunedMaintainers, [bMember], "revoke prunes the now-ineligible explicit maintainer");
  const pruneAudit = (await pool.query(`select 1 from audit_log where action = 'skill.maintainer_removed' and target_id = $1 and before->>'userId' = $2`, [skillId, bMember])).rowCount;
  assert.equal(pruneAudit, 1, "pruning is audited");
  const unshareAudit = (await pool.query<{ after: { via: string } }>(`select after from audit_log where action = 'skill.namespace_unshared' and target_id = $1`, [skillId])).rows;
  assert.deepEqual(unshareAudit.map((r) => r.after.via), ["manage"]);
  assert.equal(await find(access([[B, "namespace_member"]])), undefined, "after revoke the grantee no longer sees it");
  assert.equal((await inTransaction((client) => removeGrant(client, skillRef, B, bAdmin, "manage"))).removed, false, "revoke is idempotent");

  // ── 7. Re-version sync (direct publish): grants add/remove to match ──────────────────────
  await inTransaction((client) =>
    materializeVersion(client, {
      targetNamespaceId: A, targetSkillId: skillId, semver: "1.1.0", submittedBy: aAdmin, actorUserId: aAdmin, via: "direct_publish",
      payload: { metadata: { ...meta, whatChanged: "share with charlie", sharedNamespaceIds: [C] }, artifactObjectKey: `uploads/${aAdmin}/y.bundle`, artifactSha256: "s2" },
    }),
  );
  assert.deepEqual((await listGrants(skillId)).map((g) => g.namespaceId), [C], "re-version synced the list");
  const via = (await pool.query<{ via: string }>(`select after->>'via' as via from audit_log where action = 'skill.namespace_shared' and target_id = $1 and after->>'namespaceId' = $2`, [skillId, C])).rows;
  assert.deepEqual(via.map((r) => r.via), ["direct_publish"]);
  // Omitted list ⇒ untouched.
  await inTransaction((client) =>
    materializeVersion(client, {
      targetNamespaceId: A, targetSkillId: skillId, semver: "1.2.0", submittedBy: aAdmin,
      payload: { metadata: { ...meta, whatChanged: "no grant field", sharedNamespaceIds: undefined }, artifactObjectKey: `uploads/${aAdmin}/z.bundle`, artifactSha256: "s3" },
    }),
  );
  assert.deepEqual((await listGrants(skillId)).map((g) => g.namespaceId), [C], "an omitted list leaves grants untouched (MCP)");

  // ── 8. Namespace marketplaces carry shared skills (§30) ──────────────────────────────────
  assert.equal(await marketplaceSkillCount({ kind: "namespace", namespaceSlug: `${K}-c` }, C), 1, "the grantee's marketplace lists the shared skill");
  assert.equal(await marketplaceSkillCount({ kind: "namespace", namespaceSlug: `${K}-a` }, A), 1, "so does the owner's");
  assert.equal(await marketplaceSkillCount({ kind: "namespace", namespaceSlug: `${K}-b` }, B), 0, "a revoked grantee's does not");

  // ── 9. A deleted namespace's grants cascade away ─────────────────────────────────────────
  await pool.query(`delete from role_mappings where namespace_id = $1`, [C]);
  await pool.query(`delete from namespaces where id = $1`, [C]).catch(() => undefined); // audit rows may pin it
  const left = (await pool.query(`select 1 from namespaces where id = $1`, [C])).rowCount;
  if (!left) assert.deepEqual(await listGrants(skillId), [], "FK cascade removed the grant");
});
