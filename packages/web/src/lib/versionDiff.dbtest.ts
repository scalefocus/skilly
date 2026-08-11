// Live-DB integration test for the published per-version file-change baseline (SKILLY_SPEC.md §10):
// which two stored artifacts a version's diff compares. Covers the channel/status-blind predecessor
// rule (a beta or a yanked version still counts), the first-version case, and the unmirrored-side
// case. Only the DB half is exercised — `resolveVersionPairKeys` touches no bytes, so MinIO isn't
// needed; the classification half is unit-tested in versionDiff.test.ts.
// Gated behind SKILLY_DB_E2E=1:
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { resolveVersionPairKeys } from "./versionDiff";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

after(async () => {
  if (enabled) await pool.end();
});

test("version diff baseline = the immediate predecessor, any channel or status", { skip: !enabled }, async () => {
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ('vdiff-ns','VDiff NS', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  )).rows[0]!.id;
  const author = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ('vdiff-author','vd@org','VD')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
  )).rows[0]!.id;
  const skill = (await pool.query<{ id: string }>(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
     values ($1,'vdiff-skill','VDiff','d','claude','hosted','org','active')
     on conflict (namespace_id, slug) do update set title = excluded.title returning id`,
    [ns],
  )).rows[0]!.id;
  await pool.query(`delete from skill_versions where skill_id = $1`, [skill]);

  const mkVersion = (semver: string, opts: { prerelease?: boolean; yanked?: boolean; key?: string | null } = {}) =>
    pool.query(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
       values ($1,$2,$3,$4,$5,'h',$6,true)`,
      [skill, semver, opts.prerelease ?? false, opts.yanked ? "yanked" : "active", opts.key === undefined ? `k/${semver}` : opts.key, author],
    );

  await mkVersion("1.0.0");
  await mkVersion("1.0.1", { yanked: true });
  await mkVersion("1.1.0-beta.1", { prerelease: true });
  await mkVersion("1.1.0");

  // A yanked version is still the predecessor — the list is a chain of what actually happened.
  const afterYanked = await resolveVersionPairKeys(skill, "1.1.0-beta.1");
  assert.ok("baselineSemver" in afterYanked);
  assert.equal(afterYanked.baselineSemver, "1.0.1");
  assert.equal(afterYanked.baseKey, "k/1.0.1");
  assert.equal(afterYanked.selfKey, "k/1.1.0-beta.1");

  // A prerelease is the predecessor of its own release (NOT "latest stable", which is the
  // reviewer view's baseline — §8 vs §10).
  const afterBeta = await resolveVersionPairKeys(skill, "1.1.0");
  assert.ok("baselineSemver" in afterBeta && afterBeta.baselineSemver === "1.1.0-beta.1");

  // The lowest version has nothing to compare against.
  assert.deepEqual(await resolveVersionPairKeys(skill, "1.0.0"), { reason: "first" });
  // An unknown semver never resolves to a pair (the route 404s it before this point).
  assert.deepEqual(await resolveVersionPairKeys(skill, "9.9.9"), { reason: "first" });

  // A side whose artifact isn't stored yet (pointer mirror still pending, §6) → "pending".
  await mkVersion("1.2.0", { key: null });
  assert.deepEqual(await resolveVersionPairKeys(skill, "1.2.0"), { reason: "pending" });
  await mkVersion("1.3.0");
  assert.deepEqual(await resolveVersionPairKeys(skill, "1.3.0"), { reason: "pending" }, "an unmirrored BASELINE also blocks");

  await pool.query(`delete from skill_versions where skill_id = $1`, [skill]);
});
