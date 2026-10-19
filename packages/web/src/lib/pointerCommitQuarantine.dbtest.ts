// Live-DB integration test for migration 0097 (SKILLY_SPEC.md §49.2, §49.3, §49.13): the pinned
// pointer commit, the `quarantined` version status, the pre-scan digest columns and the
// `scan_pending` routing reason. Gated behind SKILLY_DB_E2E=1 (see admin.dbtest.ts for the run
// recipe; needs migrations through 0097).
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… node --import tsx --test src/lib/pointerCommitQuarantine.dbtest.ts
//
// Every write happens inside one transaction that is rolled back (skill_versions rows cannot be
// deleted), except the fixed actor user, which is upserted and left in place.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";
const K = `pcq${Date.now().toString(36)}`;
const SHA40 = "0123456789abcdef0123456789abcdef01234567";
const SHA64 = SHA40 + "89abcdef0123456789abcdef";

after(async () => {
  if (enabled) await pool.end();
});

async function failure(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

/** Runs `fn` inside a savepoint so a refused statement does not abort the outer transaction. */
async function attempt(c: PoolClient, sql: string, params: unknown[]): Promise<string | null> {
  await c.query("savepoint sp");
  const msg = await failure(c.query(sql, params));
  await c.query(msg === null ? "release savepoint sp" : "rollback to savepoint sp");
  return msg;
}

test("0097: external_commit pin, quarantined status, digest columns, scan_pending routing", { skip: !enabled }, async () => {
  const actor = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ('pcq-oid','pcq@org','Pointer Commit')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
  )).rows[0]!.id;

  const c = await pool.connect();
  try {
    await c.query("begin");
    const ns = (await c.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ($1, 'PCQ', true) returning id`, [`${K}-ns`],
    )).rows[0]!.id;
    const skill = (await c.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1, $2, 'PCQ', 'd', 'generic', 'pointer', 'org', 'active') returning id`,
      [ns, `${K}-skill`],
    )).rows[0]!.id;
    const version = (sv: string, status: string, commit: string | null) =>
      c.query<{ id: string }>(
        `insert into skill_versions (skill_id, semver, is_prerelease, status, external_ref, external_origin_url, external_commit, created_by)
         values ($1, $2, false, $3::version_status, 'v' || $2, 'https://example.invalid/r.git', $4, $5) returning id`,
        [skill, sv, status, commit, actor],
      );

    // ── skill_versions.external_commit: 40 lowercase hex or null ──────────────────────────────
    const pinned = (await version("1.0.0", "active", SHA40)).rows[0]!.id;
    assert.ok(pinned, "a 40-hex commit is accepted");
    const unpinned = (await version("1.0.1", "active", null)).rows[0]!.id;
    assert.ok(unpinned, "null is accepted (registry-origin and pre-0097 rows)");
    for (const bad of [SHA40.slice(0, 39), SHA40 + "0", SHA40.toUpperCase(), "v1.2.3", ""]) {
      const msg = await attempt(c,
        `insert into skill_versions (skill_id, semver, is_prerelease, status, external_ref, external_origin_url, external_commit, created_by)
         values ($1, '9.9.9', false, 'active', 'v9.9.9', 'https://example.invalid/r.git', $2, $3)`,
        [skill, bad, actor]);
      assert.ok(msg && /skill_versions_external_commit_check/.test(msg), `refuses ${JSON.stringify(bad)}: ${msg}`);
    }

    // ── external_commit is in the guard's pinned set; status stays mutable ───────────────────
    let msg = await attempt(c, `update skill_versions set external_commit = $2 where id = $1`, [pinned, SHA40.replace(/0/g, "f")]);
    assert.equal(msg, "published skill_version content is immutable", "the pinned commit cannot change");
    msg = await attempt(c, `update skill_versions set external_commit = null where id = $1`, [pinned]);
    assert.equal(msg, "published skill_version content is immutable", "the pinned commit cannot be cleared");
    msg = await attempt(c, `update skill_versions set external_commit = $2 where id = $1`, [unpinned, SHA40]);
    assert.equal(msg, "published skill_version content is immutable", "a null pin cannot be filled in later (no backfill)");
    assert.equal(await attempt(c, `update skill_versions set git_published = true where id = $1`, [pinned]), null, "git_published stays mutable");

    // ── version_status gains 'quarantined' ────────────────────────────────────────────────────
    const labels = (await c.query<{ l: string }>(`select unnest(enum_range(null::version_status))::text as l`)).rows.map((r) => r.l);
    assert.deepEqual(labels, ["active", "yanked", "quarantined"]);
    const quarantined = (await version("2.0.0", "quarantined", SHA40)).rows[0]!.id;
    assert.ok(quarantined, "a version can be inserted quarantined");
    assert.equal(await attempt(c, `update skill_versions set status = 'active' where id = $1`, [quarantined]), null, "release: quarantined → active");
    assert.equal(await attempt(c, `update skill_versions set status = 'quarantined' where id = $1`, [quarantined]), null);
    assert.equal(await attempt(c, `update skill_versions set status = 'yanked' where id = $1`, [quarantined]), null, "yank: quarantined → yanked");

    // ── pending_mirrors.external_commit + prescan_content_sha256 ─────────────────────────────
    const mirror = (sv: string, commit: string | null, digest: string | null) =>
      attempt(c,
        `insert into pending_mirrors (skill_id, semver, external_url, external_ref, external_commit, prescan_content_sha256, created_by)
         values ($1, $2, 'https://example.invalid/r.git', 'v' || $2, $3, $4, $5)`,
        [skill, sv, commit, digest, actor]);
    assert.equal(await mirror("3.0.0", SHA40, SHA64), null, "queue row with both pins");
    assert.equal(await mirror("3.0.1", null, null), null, "queue row without pins (registry-origin)");
    msg = await mirror("3.0.2", SHA40.slice(0, 10), null);
    assert.ok(msg && /pending_mirrors_external_commit_check/.test(msg), `queue refuses a short commit: ${msg}`);
    msg = await mirror("3.0.3", SHA40, SHA64.slice(0, 63));
    assert.ok(msg && /pending_mirrors_prescan_content_sha256_check/.test(msg), `queue refuses a short digest: ${msg}`);
    msg = await mirror("3.0.4", SHA40, SHA64.toUpperCase());
    assert.ok(msg && /pending_mirrors_prescan_content_sha256_check/.test(msg), `queue refuses an uppercase digest: ${msg}`);

    // ── scan_reports.content_sha256 is a nullable text column; status is free text ───────────
    assert.equal(await attempt(c,
      `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status, cached_for_ref, content_sha256)
       values ('proposal', $1, 'pre-scan', '[]', null, 'source_changed', 'v1.0.0@' || $2, $3)`,
      [`${K}-proposal`, SHA40, SHA64]), null, "a source_changed report carries the digest");
    assert.equal(await attempt(c,
      `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status)
       values ('proposal', $1, 'pre-scan', '[]', null, 'scanned')`, [`${K}-proposal`]), null, "content_sha256 is nullable");

    // ── proposals.routed_reason gains 'scan_pending' ──────────────────────────────────────────
    const proposal = (reason: string | null) =>
      attempt(c,
        `insert into proposals (target_namespace_id, target_skill_id, proposed_semver, submitted_by, routed_reason)
         values ($1, $2, '4.0.0', $3, $4)`,
        [ns, skill, actor, reason]);
    for (const ok of ["scan_pending", "content_risk", "policy", null]) {
      assert.equal(await proposal(ok), null, `routed_reason ${ok} is accepted`);
    }
    msg = await proposal("something_else");
    assert.ok(msg && /proposals_routed_reason_check/.test(msg), `an unknown reason is refused: ${msg}`);
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
});
