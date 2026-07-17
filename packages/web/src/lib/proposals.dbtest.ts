// Live-DB integration test for the proposal materialize path (SKILLY_SPEC.md §8). Gated by
// SKILLY_DB_E2E=1. The pure state machine is unit-tested in shared/proposal.test.ts; this
// covers the DB-backed materialize-on-accept: skill + immutable version insert, submitter
// auto-add as maintainer on CREATION (§19), category attach, per-version usage_examples (§20),
// the skill-level metadata sync on re-version, the "Keep current files" reuse path (§8), and
// submitter auto-add as maintainer on an accepted NEW VERSION of an already-existing skill —
// eligibility-gated, idempotent, and skipping a redundant row for an implicit namespace-admin
// maintainer (§19).
// Runs inside a transaction and rolls back — no persistent state, no audit/FK pollution.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { materializeVersion, resolveReuseSource, verifySubmissionPayload, applyReuseToPayload } from "./proposals";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

after(async () => {
  if (enabled) await pool.end();
});

/** Seed a namespace + user inside the caller's transaction. */
async function seed(client: PoolClient, key: string): Promise<{ ns: string; user: string }> {
  const ns = (await client.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ($1, $1, true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
    [`${key}-ns`],
  )).rows[0]!.id;
  const user = (await client.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ($1, $2, 'Sub')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
    [`${key}-sub`, `${key}@org`],
  )).rows[0]!.id;
  return { ns, user };
}

/** A bare extra user (no group membership) inside the caller's transaction — for maintainer eligibility tests. */
async function mkUser(client: PoolClient, key: string): Promise<string> {
  return (
    await client.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ($1, $2, 'U')
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
      [key, `${key}@org`],
    )
  ).rows[0]!.id;
}

test("proposal materialize: skill + version + maintainer + categories + usage", { skip: !enabled }, async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { ns, user: submitter } = await seed(client, "mat");

    const res = await materializeVersion(client, {
      targetNamespaceId: ns,
      targetSkillId: null,
      semver: "1.0.0",
      submittedBy: submitter,
      payload: {
        metadata: {
          skillSlug: "mat-skill",
          title: "Mat Skill",
          description: "d",
          toolHarness: "claude-code",
          visibility: "org",
          categories: ["Alpha", "beta"],
          usageExamples: "Trigger by asking to mat.",
        },
        artifactObjectKey: "uploads/x/key.bundle",
        artifactSha256: "abc123",
      },
    });
    assert.ok(res.skillId && res.versionId, "skill + version created");

    const v = (await client.query<{ usage_examples: string | null; artifact_object_key: string | null; status: string }>(
      `select usage_examples, artifact_object_key, status from skill_versions where id = $1`,
      [res.versionId],
    )).rows[0]!;
    assert.equal(v.status, "active");
    assert.equal(v.artifact_object_key, "uploads/x/key.bundle");
    assert.equal(v.usage_examples, "Trigger by asking to mat.", "usage frozen on the version (§20)");

    const isMaintainer = (await client.query(`select 1 from skill_maintainers where skill_id = $1 and user_id = $2`, [res.skillId, submitter])).rowCount;
    assert.equal(isMaintainer, 1, "submitter auto-added as maintainer (§19)");

    const cats = (await client.query<{ name: string }>(
      `select c.name from skill_categories sc join categories c on c.id = sc.category_id where sc.skill_id = $1 order by c.name`,
      [res.skillId],
    )).rows.map((r) => r.name);
    assert.deepEqual(cats, ["alpha", "beta"], "categories normalized + attached");

    // Immutable semver: a second version at the same semver is rejected.
    await assert.rejects(
      materializeVersion(client, {
        targetNamespaceId: ns,
        targetSkillId: res.skillId,
        semver: "1.0.0",
        submittedBy: submitter,
        payload: { metadata: { skillSlug: "mat-skill", title: "x", description: "d", toolHarness: "claude-code", visibility: "org" }, artifactObjectKey: "uploads/x/k2.bundle", artifactSha256: "z" },
      }),
      "strictly-increasing semver enforced",
    );

    await client.query("rollback");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
});

test("re-version syncs skill-level metadata: title/description/categories/tags/harness (§8)", { skip: !enabled }, async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { ns, user: submitter } = await seed(client, "sync");

    const first = await materializeVersion(client, {
      targetNamespaceId: ns,
      targetSkillId: null,
      semver: "1.0.0",
      submittedBy: submitter,
      payload: {
        metadata: {
          skillSlug: "sync-skill", title: "Old Title", description: "old desc", toolHarness: "claude-code",
          visibility: "org", categories: ["alpha"], tags: ["one"], usageExamples: "old usage",
        },
        artifactObjectKey: "uploads/x/sync1.bundle",
        artifactSha256: "s1",
      },
    });

    // New version with every skill-level field changed — synced on materialize.
    const second = await materializeVersion(client, {
      targetNamespaceId: ns,
      targetSkillId: first.skillId,
      semver: "1.1.0",
      submittedBy: submitter,
      payload: {
        metadata: {
          skillSlug: "sync-skill", title: "New Title", description: "new desc", toolHarness: "cursor",
          visibility: "org", categories: ["beta", "gamma"], tags: ["two", "three"], usageExamples: "new usage",
        },
        artifactObjectKey: "uploads/x/sync2.bundle",
        artifactSha256: "s2",
      },
    });
    assert.ok(second.versionId, "second version created");

    const s = (await client.query<{ title: string; description: string; tool_harness: string; tags: string[] }>(
      `select title, description, tool_harness, tags from skills where id = $1`,
      [first.skillId],
    )).rows[0]!;
    assert.equal(s.title, "New Title", "title synced (§8)");
    assert.equal(s.description, "new desc", "description synced");
    assert.equal(s.tool_harness, "cursor", "tool/harness synced");
    assert.deepEqual([...s.tags].sort(), ["three", "two"], "tags synced");
    const cats = (await client.query<{ name: string }>(
      `select c.name from skill_categories sc join categories c on c.id = sc.category_id where sc.skill_id = $1 order by c.name`,
      [first.skillId],
    )).rows.map((r) => r.name);
    assert.deepEqual(cats, ["beta", "gamma"], "categories fully re-synced (alpha removed)");

    // The first version's own row is untouched (immutability, invariant #2).
    const v1 = (await client.query<{ usage_examples: string }>(`select usage_examples from skill_versions where id = $1`, [first.versionId])).rows[0]!;
    assert.equal(v1.usage_examples, "old usage", "prior version frozen");

    await client.query("rollback");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
});

test("new-version acceptance auto-adds submitter as maintainer, idempotent, skips implicit admin (§19)", { skip: !enabled }, async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { ns, user: creator } = await seed(client, "vernew");
    const contributor = await mkUser(client, "vernew-contrib");
    const nsAdmin = await mkUser(client, "vernew-nsadmin");

    const adminGroup = (await client.query<{ id: string }>(
      `insert into groups (entra_object_id, display_name) values ($1, 'VerNew Admins')
       on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
      ["vernew-admin-grp"],
    )).rows[0]!.id;
    await client.query(`insert into role_mappings (group_id, namespace_id, role) values ($1,$2,'namespace_admin') on conflict do nothing`, [adminGroup, ns]);
    await client.query(`insert into group_memberships (group_id, user_id) values ($1,$2) on conflict do nothing`, [adminGroup, nsAdmin]);

    const meta = { skillSlug: "vernew-skill", title: "VerNew Skill", description: "d", toolHarness: "claude-code", visibility: "org" as const };
    const first = await materializeVersion(client, {
      targetNamespaceId: ns, targetSkillId: null, semver: "1.0.0", submittedBy: creator,
      payload: { metadata: meta, artifactObjectKey: "uploads/x/vn1.bundle", artifactSha256: "vn1" },
    });

    // A different, eligible contributor submits an accepted new version → auto-added as maintainer.
    await materializeVersion(client, {
      targetNamespaceId: ns, targetSkillId: first.skillId, semver: "1.1.0", submittedBy: contributor,
      payload: { metadata: meta, artifactObjectKey: "uploads/x/vn2.bundle", artifactSha256: "vn2" },
    });
    let row = (await client.query(`select 1 from skill_maintainers where skill_id = $1 and user_id = $2`, [first.skillId, contributor])).rowCount;
    assert.equal(row, 1, "new-version submitter auto-added as maintainer (§19)");
    let autoAdds = (await client.query<{ action: string }>(
      `select action from audit_log where target_id = $1 and action = 'skill.maintainer_auto_added'`,
      [first.skillId],
    )).rows;
    assert.equal(autoAdds.length, 1, "audited as a distinct action, once");

    // The SAME contributor submits another accepted version → no duplicate row, no duplicate audit.
    await materializeVersion(client, {
      targetNamespaceId: ns, targetSkillId: first.skillId, semver: "1.2.0", submittedBy: contributor,
      payload: { metadata: meta, artifactObjectKey: "uploads/x/vn3.bundle", artifactSha256: "vn3" },
    });
    const count = (await client.query<{ n: string }>(
      `select count(*)::text as n from skill_maintainers where skill_id = $1 and user_id = $2`,
      [first.skillId, contributor],
    )).rows[0]!.n;
    assert.equal(count, "1", "idempotent — no duplicate row for a repeat contributor");
    autoAdds = (await client.query<{ action: string }>(
      `select action from audit_log where target_id = $1 and action = 'skill.maintainer_auto_added'`,
      [first.skillId],
    )).rows;
    assert.equal(autoAdds.length, 1, "idempotent — no duplicate audit entry");

    // A namespace ADMIN submits a version → already an implicit maintainer, so no redundant explicit row.
    await materializeVersion(client, {
      targetNamespaceId: ns, targetSkillId: first.skillId, semver: "1.3.0", submittedBy: nsAdmin,
      payload: { metadata: meta, artifactObjectKey: "uploads/x/vn4.bundle", artifactSha256: "vn4" },
    });
    row = (await client.query(`select 1 from skill_maintainers where skill_id = $1 and user_id = $2`, [first.skillId, nsAdmin])).rowCount;
    assert.equal(row, 0, "namespace admin NOT added explicitly — already an implicit maintainer");

    await client.query("rollback");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
});

test("new-version acceptance respects the visibility-eligibility gate for a cross-namespace submitter (§19)", { skip: !enabled }, async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { ns } = await seed(client, "vergate");
    const member = await mkUser(client, "vergate-member");
    const outsider = await mkUser(client, "vergate-outsider"); // no role_mapping anywhere in `ns`

    const memberGroup = (await client.query<{ id: string }>(
      `insert into groups (entra_object_id, display_name) values ($1, 'VerGate Members')
       on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
      ["vergate-member-grp"],
    )).rows[0]!.id;
    await client.query(`insert into role_mappings (group_id, namespace_id, role) values ($1,$2,'namespace_member') on conflict do nothing`, [memberGroup, ns]);
    await client.query(`insert into group_memberships (group_id, user_id) values ($1,$2) on conflict do nothing`, [memberGroup, member]);

    const meta = { skillSlug: "vergate-skill", title: "VerGate Skill", description: "d", toolHarness: "claude-code", visibility: "namespace" as const };
    const first = await materializeVersion(client, {
      targetNamespaceId: ns, targetSkillId: null, semver: "1.0.0", submittedBy: member,
      payload: { metadata: meta, artifactObjectKey: "uploads/x/vg1.bundle", artifactSha256: "vg1" },
    });
    const creatorRow = (await client.query(`select 1 from skill_maintainers where skill_id = $1 and user_id = $2`, [first.skillId, member])).rowCount;
    assert.equal(creatorRow, 1, "eligible creator auto-added at creation (§19 baseline)");

    // An outsider with no role anywhere in `ns` submits an accepted new version of a namespace-restricted skill.
    await materializeVersion(client, {
      targetNamespaceId: ns, targetSkillId: first.skillId, semver: "1.1.0", submittedBy: outsider,
      payload: { metadata: meta, artifactObjectKey: "uploads/x/vg2.bundle", artifactSha256: "vg2" },
    });
    const outsiderRow = (await client.query(`select 1 from skill_maintainers where skill_id = $1 and user_id = $2`, [first.skillId, outsider])).rowCount;
    assert.equal(outsiderRow, 0, "ineligible cross-namespace submitter skipped (invariant #3)");
    const auditRows = (await client.query<{ action: string }>(
      `select action from audit_log where target_id = $1 and action = 'skill.maintainer_auto_added' and after->>'userId' = $2`,
      [first.skillId, outsider],
    )).rows;
    assert.equal(auditRows.length, 0, "no audit entry for a skipped, ineligible submitter");

    await client.query("rollback");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
});

test("keep current files: resolveReuseSource snapshots latest stable + no-op guard (§8)", { skip: !enabled }, async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { ns, user: submitter } = await seed(client, "reuse");

    const meta = {
      skillSlug: "reuse-skill", title: "Reuse Skill", description: "d", toolHarness: "claude-code",
      visibility: "org" as const, categories: ["alpha"], tags: ["t1"], usageExamples: "usage v1",
    };
    const first = await materializeVersion(client, {
      targetNamespaceId: ns, targetSkillId: null, semver: "1.0.0", submittedBy: submitter,
      payload: { metadata: meta, artifactObjectKey: "uploads/x/r1.bundle", artifactSha256: "r1", contentSha256: "c1", artifactFilename: "reuse-skill.skill" },
    });
    // A newer PRERELEASE must NOT be the reuse source — latest STABLE wins.
    await materializeVersion(client, {
      targetNamespaceId: ns, targetSkillId: first.skillId, semver: "2.0.0-beta.1", submittedBy: submitter,
      payload: { metadata: meta, artifactObjectKey: "uploads/x/r2.bundle", artifactSha256: "r2" },
    });

    // No-op: identical metadata + identical usage → rejected.
    const noop = await resolveReuseSource(client, first.skillId, { ...meta });
    assert.equal(noop.ok, false, "no-op reuse rejected");
    assert.match((noop as { error: string }).error, /nothing changed/i);

    // A changed title passes, and the snapshot pins the latest STABLE version's artifact.
    const ok = await resolveReuseSource(client, first.skillId, { ...meta, title: "Renamed Skill" });
    assert.equal(ok.ok, true, "changed title passes the guard");
    const reuse = (ok as Extract<Awaited<ReturnType<typeof resolveReuseSource>>, { ok: true }>).reuse;
    assert.equal(reuse.fromSemver, "1.0.0", "latest STABLE reused (prerelease skipped)");
    assert.equal(reuse.artifactObjectKey, "uploads/x/r1.bundle");
    assert.equal(reuse.artifactFilename, "reuse-skill.skill");
    assert.equal(reuse.external, null, "hosted skill → no external provenance");

    // Materialize the reuse: same artifact referenced (no copy), no pending mirror. The semver
    // must still strictly increase past EVERY existing version (the 2.0.0-beta.1 above included).
    const payload = applyReuseToPayload({ metadata: { ...meta, title: "Renamed Skill" } }, reuse);
    const v2 = await materializeVersion(client, {
      targetNamespaceId: ns, targetSkillId: first.skillId, semver: "2.0.0", submittedBy: submitter, payload,
    });
    assert.ok(v2.versionId && !v2.pendingMirror, "reuse inserts the version directly");
    const row = (await client.query<{ artifact_object_key: string; artifact_sha256: string; external_origin_url: string | null }>(
      `select artifact_object_key, artifact_sha256, external_origin_url from skill_versions where id = $1`,
      [v2.versionId],
    )).rows[0]!;
    assert.equal(row.artifact_object_key, "uploads/x/r1.bundle", "same object referenced — no copy");
    assert.equal(row.artifact_sha256, "r1");
    assert.equal(row.external_origin_url, null);
    const title = (await client.query<{ title: string }>(`select title from skills where id = $1`, [first.skillId])).rows[0]!;
    assert.equal(title.title, "Renamed Skill", "retitle synced on accept");

    await client.query("rollback");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
});

test("keep current files: pointer reuse carries external provenance, no mirror (§8)", { skip: !enabled }, async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { ns, user: submitter } = await seed(client, "preuse");

    // Simulate an already-mirrored pointer version (the worker inserts these post-mirror).
    const skillId = (await client.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
       values ($1, 'preuse-skill', 'Pointer Skill', 'd', 'generic', 'pointer', 'org') returning id`,
      [ns],
    )).rows[0]!.id;
    await client.query(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256,
                                   external_origin_url, external_ref, external_subdir, created_by, git_published)
       values ($1, '1.0.0', false, 'active', 'mirrors/preuse/1.0.0.tgz', 'p1', 'https://github.com/org/repo.git', 'v1.0.0', 'skills/preuse', $2, true)`,
      [skillId, submitter],
    );

    const r = await resolveReuseSource(client, skillId, {
      skillSlug: "preuse-skill", title: "Pointer Skill RENAMED", description: "d", toolHarness: "generic",
      visibility: "org", categories: [], tags: [], usageExamples: null,
    });
    assert.equal(r.ok, true, "pointer reuse resolves");
    const reuse = (r as Extract<Awaited<ReturnType<typeof resolveReuseSource>>, { ok: true }>).reuse;
    assert.deepEqual(reuse.external, { url: "https://github.com/org/repo.git", ref: "v1.0.0", subdir: "skills/preuse" }, "external provenance snapshotted");

    const payload = applyReuseToPayload(
      { metadata: { skillSlug: "preuse-skill", title: "Pointer Skill RENAMED", description: "d", toolHarness: "generic", visibility: "org" } },
      reuse,
    );
    assert.equal(payload.pointer, undefined, "reuse never sets payload.pointer (no mirror path)");
    const v = await materializeVersion(client, { targetNamespaceId: ns, targetSkillId: skillId, semver: "1.0.1", submittedBy: submitter, payload });
    assert.ok(v.versionId && !v.pendingMirror, "pointer reuse inserts directly — no pending mirror");
    const mirrors = (await client.query(`select 1 from pending_mirrors where skill_id = $1`, [skillId])).rowCount;
    assert.equal(mirrors, 0, "no pending_mirrors row enqueued");
    const row = (await client.query<{ external_origin_url: string | null; external_ref: string | null; external_subdir: string | null; artifact_object_key: string }>(
      `select external_origin_url, external_ref, external_subdir, artifact_object_key from skill_versions where id = $1`,
      [v.versionId],
    )).rows[0]!;
    assert.equal(row.external_origin_url, "https://github.com/org/repo.git", "origin carried onto the row");
    assert.equal(row.external_ref, "v1.0.0", "same ref re-pinned");
    assert.equal(row.external_subdir, "skills/preuse");
    assert.equal(row.artifact_object_key, "mirrors/preuse/1.0.0.tgz", "mirrored artifact reused");

    await client.query("rollback");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
});

test("keep current files: no stable version → reuse unavailable (§8)", { skip: !enabled }, async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { ns, user: submitter } = await seed(client, "nostable");
    const skillId = (await client.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
       values ($1, 'nostable-skill', 'No Stable', 'd', 'generic', 'hosted', 'org') returning id`,
      [ns],
    )).rows[0]!.id;
    // Only a prerelease exists — nothing stable to reuse.
    await client.query(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by)
       values ($1, '1.0.0-beta.1', true, 'active', 'uploads/x/ns1.bundle', 'n1', $2)`,
      [skillId, submitter],
    );
    const r = await resolveReuseSource(client, skillId);
    assert.equal(r.ok, false, "no stable → reuse unavailable");
    assert.match((r as { error: string }).error, /no published stable version/i);
    await client.query("rollback");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
});

test("tool/harness carve-out: unchanged legacy value passes, changed must be closed-list (§8)", { skip: !enabled }, async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { ns } = await seed(client, "legacy");
    // A pre-closed-vocabulary skill with a legacy harness slug not in the curated list.
    const skillId = (await client.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
       values ($1, 'legacy-skill', 'Legacy', 'd', 'claude-desktop', 'hosted', 'org') returning id`,
      [ns],
    )).rows[0]!.id;

    const base = { skillSlug: "legacy-skill", title: "Legacy", description: "d", visibility: "org" as const };

    // Unchanged legacy value + targetSkillId → passes (the §8 carve-out).
    const unchanged = await verifySubmissionPayload(client, "someone", { metadata: { ...base, toolHarness: "claude-desktop" } }, { targetSkillId: skillId });
    assert.equal(unchanged, null, "unchanged legacy harness passes");

    // Same value WITHOUT a target skill (new-skill proposal) → rejected.
    const newSkill = await verifySubmissionPayload(client, "someone", { metadata: { ...base, toolHarness: "claude-desktop" } }, {});
    assert.match(newSkill ?? "", /tool\/harness/, "legacy value rejected on a new skill");

    // A CHANGED value must be in the closed list.
    const changed = await verifySubmissionPayload(client, "someone", { metadata: { ...base, toolHarness: "totally-made-up" } }, { targetSkillId: skillId });
    assert.match(changed ?? "", /tool\/harness/, "changed non-list value rejected");
    const closed = await verifySubmissionPayload(client, "someone", { metadata: { ...base, toolHarness: "cursor" } }, { targetSkillId: skillId });
    assert.equal(closed, null, "changed closed-list value passes");

    await client.query("rollback");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
});
