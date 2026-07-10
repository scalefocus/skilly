// Live-DB integration test for the proposal materialize path (SKILLY_SPEC.md §8). Gated by
// SKILLY_DB_E2E=1. The pure state machine is unit-tested in shared/proposal.test.ts; this
// covers the DB-backed materialize-on-accept: skill + immutable version insert, submitter
// auto-add as maintainer (§19), category attach, per-version usage_examples (§20), the
// skill-level metadata sync on re-version, and the "Keep current files" reuse path (§8).
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
