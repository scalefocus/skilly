// Live-DB integration test for Fresh Coat (SKILLY_SPEC.md §31.12.3): `first_update`, awarded by the
// gateway's `/info/refs` freshness stamp when an existing installation moves FORWARD to a higher
// stable version. Gated behind SKILLY_DB_E2E=1; requires a migrated Postgres at DATABASE_URL.
//
// Validates: a first clone (nothing recorded yet) awards nothing; a re-clone at the same version
// awards nothing; a re-clone after a newer stable version is published awards it once (one row,
// one notification); a pinned install never moves; a system installation earns nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pgGitDeps } from "../git/pgDeps.js";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("Fresh Coat: only a recorded install moving to a higher stable version earns it", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;
  const deps = pgGitDeps(pool);

  const ns = await one(
    `insert into namespaces (slug, display_name, require_review) values ('fc-ns','Fresh Coat NS', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  );
  const mkUser = (oid: string) =>
    one(
      `insert into users (entra_object_id, email, display_name, status) values ($1, $1 || '@org', $1, 'active')
       on conflict (entra_object_id) do update set status = 'active', erased_at = null returning id`,
      [oid],
    );
  const tracker = await mkUser("fc-tracker");
  const pinner = await mkUser("fc-pinner");
  const people = [tracker, pinner];
  await q(`delete from user_achievements where user_id = any($1::uuid[])`, [people]);
  await q(`delete from notifications where user_id = any($1::uuid[])`, [people]);

  // A fresh skill every run (versions are immutable, so a re-run must start from none).
  const dropSkill = async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(`delete from tokens where skill_id in (select id from skills where namespace_id = $1 and slug = 'fc-skill')`, [ns]);
      await c.query("set local skilly.allow_version_delete = 'on'");
      await c.query(`delete from skills where namespace_id = $1 and slug = 'fc-skill'`, [ns]);
      await c.query("commit");
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
  };
  await dropSkill();
  const skill = await one(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
     values ($1,'fc-skill','fc-skill','d','claude','hosted','org','active') returning id`,
    [ns],
  );
  const publish = (v: string) =>
    q(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
       values ($1,$2,$3,'active',$4,'h',$5,true)`,
      [skill, v, v.includes("-"), `k/fc/${v}`, tracker],
    );
  const mkInstall = (userId: string | null, pinned: string | null, system = false) =>
    one(
      `insert into tokens (user_id, type, hashed_token, skill_id, scope, used_at, pinned_semver, is_system)
       values ($1,'install',md5(random()::text),$2,'{}'::jsonb, now(), $3, $4) returning id`,
      [userId, skill, pinned, system],
    );
  const held = async (userId: string) =>
    (await q(`select 1 from user_achievements where user_id = $1 and key = 'first_update'`, [userId])).rowCount === 1;
  const notifs = async (userId: string) =>
    Number((await q<{ n: string }>(
      `select count(*)::text as n from notifications where user_id = $1 and type = 'achievement.earned' and payload->>'key' = 'first_update'`,
      [userId],
    )).rows[0]!.n);

  try {
    await publish("1.0.0");
    const latest = await mkInstall(tracker, null);
    const pinned = await mkInstall(pinner, "1.0.0");
    const system = await mkInstall(null, null, true);

    // First clones record 1.0.0 — nothing to move from yet.
    for (const t of [latest, pinned, system]) await deps.stampInstallServed(t, skill);
    assert.equal(await held(tracker), false, "a first clone is not an update");
    assert.equal(await held(pinner), false);

    // Same version again: no move.
    await deps.stampInstallServed(latest, skill);
    assert.equal(await held(tracker), false, "re-cloning the same version is not an update");

    // A prerelease never moves `latest`, so it is no update either.
    await publish("1.1.0-beta.1");
    await deps.stampInstallServed(latest, skill);
    assert.equal(await held(tracker), false, "a beta is not a move forward");

    // A newer stable version: the latest-tracking install moves forward → Fresh Coat, once.
    await publish("1.1.0");
    await deps.stampInstallServed(latest, skill);
    assert.equal(await held(tracker), true, "moving forward earns Fresh Coat");
    assert.equal(await notifs(tracker), 1);
    await publish("1.2.0");
    await deps.stampInstallServed(latest, skill);
    assert.equal(await notifs(tracker), 1, "the badge is earned once");

    // A pinned install re-stamps its own pin; a system installation has no user.
    await deps.stampInstallServed(pinned, skill);
    await deps.stampInstallServed(system, skill);
    assert.equal(await held(pinner), false, "a pinned install cannot move");
    const stamped = (await q<{ last_served_semver: string | null }>(`select last_served_semver from tokens where id = $1`, [system])).rows[0]!;
    assert.equal(stamped.last_served_semver, "1.2.0", "the system install is still stamped");
  } finally {
    await dropSkill();
    await q(`delete from user_achievements where user_id = any($1::uuid[])`, [people]);
    await q(`delete from notifications where user_id = any($1::uuid[])`, [people]);
    await pool.end();
  }
});
