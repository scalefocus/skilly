// Live-DB integration test for the hype sweep (SKILLY_SPEC.md §50.5, §50.7, §50.9).
// Gated behind SKILLY_DB_E2E=1; requires a migrated Postgres at DATABASE_URL.
//
// Validates: the first pass records ENTRIES for the top N (skill_hype_top open rows), notifies the
// skill's effective maintainers minus `hype_notifications` opt-outs, awards `hype_train` to the
// effective maintainers and `talent_scout` to every in-window hyper; a second pass with nothing
// changed is a no-op; a skill pushed out records an EXIT; a re-entry within 7 days records the entry
// but does not notify again; a hard-ineligible (deprecated) skill exits at once; a lowered top N
// records the exits; the sweep skips entirely while `hype_enabled` is off.
//
// The board is global, so this test gives its own skills scores far above anything a dev database
// normally holds (the other hype test cleans up after itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepHype } from "../hype.js";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("hype sweep: entries, exits, notification dedup, awards, kill switch", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;
  const setSetting = (key: string, value: unknown) =>
    q(
      `insert into platform_settings (key, value, updated_at) values ($1, $2::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );

  const ns = await one(
    `insert into namespaces (slug, display_name, require_review) values ('hsw-ns','Hype Sweep NS', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  );
  const mkUser = (oid: string, hypeNotifications = true) =>
    one(
      `insert into users (entra_object_id, email, display_name, status, hype_notifications) values ($1, $1 || '@org', $1, 'active', $2)
       on conflict (entra_object_id) do update set status = 'active', hype_notifications = excluded.hype_notifications returning id`,
      [oid, hypeNotifications],
    );
  const maint = await mkUser("hsw-maint");
  const optOut = await mkUser("hsw-optout", false);
  const nsAdmin = await mkUser("hsw-nsadmin");
  const hypers: string[] = [];
  for (let i = 1; i <= 20; i++) hypers.push(await mkUser(`hsw-u-${i}`));
  const everyone = [maint, optOut, nsAdmin, ...hypers];

  const grp = await one(
    `insert into groups (entra_object_id, display_name) values ('hsw-admin-grp','Hype Sweep Admins')
     on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
  );
  await q(`insert into role_mappings (group_id, namespace_id, role) values ($1,$2,'namespace_admin') on conflict do nothing`, [grp, ns]);
  await q(`insert into group_memberships (group_id, user_id) values ($1,$2) on conflict do nothing`, [grp, nsAdmin]);

  const mkSkill = async (slug: string) => {
    const id = await one(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1,$2,$2,'d','claude','hosted','org','active')
       on conflict (namespace_id, slug) do update set status = 'active', deprecated_at = null, visibility = 'org' returning id`,
      [ns, slug],
    );
    await q(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
       values ($1,'1.0.0',false,'active',$3,'h',$2,true)
       on conflict (skill_id, semver) do update set status = 'active', git_published = true`,
      [id, maint, `k/hsw/${id}`],
    );
    return id;
  };
  const s1 = await mkSkill("hsw-one");
  const s2 = await mkSkill("hsw-two");
  const s3 = await mkSkill("hsw-three");
  const skills = [s1, s2, s3];
  await q(`insert into skill_maintainers (skill_id, user_id) values ($1,$2),($1,$3) on conflict do nothing`, [s1, maint, optOut]);

  const clean = async () => {
    await q(`delete from skill_hypes where skill_id = any($1::uuid[])`, [skills]);
    await q(`delete from skill_hype_top where skill_id = any($1::uuid[])`, [skills]);
    await q(`delete from notifications where type in ('skill.hyped', 'achievement.earned', 'follow.achievement') and user_id = any($1::uuid[])`, [everyone]);
    await q(`delete from user_achievements where key in ('hype_train', 'talent_scout') and user_id = any($1::uuid[])`, [everyone]);
  };
  // `n` hypes of 3 points by the first `n` hypers (offset lets two skills use different people).
  const hype = async (skillId: string, n: number, offset = 0, ageMinutes = 1) => {
    for (let i = 0; i < n; i++) {
      await q(`insert into skill_hypes (skill_id, user_id, points, created_at) values ($1,$2,3, now() - ($3 || ' minutes')::interval)`, [
        skillId, hypers[(offset + i) % hypers.length], String(ageMinutes),
      ]);
    }
  };
  const openTop = async () =>
    new Set((await q<{ skill_id: string }>(`select skill_id from skill_hype_top where left_at is null and skill_id = any($1::uuid[])`, [skills])).rows.map((r) => r.skill_id));
  const hypedRows = async (userId: string) =>
    (await q<{ n: number }>(`select count(*)::int as n from notifications where type = 'skill.hyped' and user_id = $1`, [userId])).rows[0]!.n;
  const holds = async (userId: string, key: string) =>
    (await q(`select 1 from user_achievements where user_id = $1 and key = $2`, [userId, key])).rowCount === 1;

  await clean();
  await setSetting("hype_enabled", true);
  await setSetting("hype_top_n", 2);
  try {
    // s1: 40 hypes worth of score (by 20 people, hyped twice — rows are not unique by design),
    // s2: 30, s3: 6. With top N = 2, s1 and s2 enter.
    await hype(s1, 20, 0);
    await hype(s1, 20, 0, 2);
    await hype(s2, 10, 0);
    await hype(s2, 10, 5, 3);
    await hype(s3, 2, 18);

    const first = await sweepHype(pool);
    assert.equal(first.skipped, false);
    assert.ok(first.entries.includes(s1) && first.entries.includes(s2), "s1 and s2 enter");
    assert.equal(first.entries.includes(s3), false);
    assert.deepEqual(await openTop(), new Set([s1, s2]));

    // Notifications: maint (explicit, s1) once; the ns admin for both skills; the opted-out
    // co-maintainer never.
    assert.equal(await hypedRows(maint), 1);
    assert.equal(await hypedRows(nsAdmin), 2);
    assert.equal(await hypedRows(optOut), 0, "hype_notifications = false ⇒ no row");
    const payload = (await q<{ payload: Record<string, unknown> }>(
      `select payload from notifications where type = 'skill.hyped' and user_id = $1`, [maint],
    )).rows[0]!.payload;
    assert.equal(payload.skillSlug, "hsw-one");
    assert.equal(payload.namespaceSlug, "hsw-ns");
    assert.equal(payload.rank, 1);
    assert.equal(payload.topN, 2);

    // Awards: hype_train for every effective maintainer (opt-out only silences the notification),
    // talent_scout for the hypers of the entering skills.
    assert.equal(await holds(maint, "hype_train"), true);
    assert.equal(await holds(optOut, "hype_train"), true);
    assert.equal(await holds(nsAdmin, "hype_train"), true);
    assert.equal(await holds(hypers[0]!, "talent_scout"), true);
    assert.equal(await holds(hypers[18]!, "talent_scout"), true, "hyped s1 (20 people) — included");

    // Second pass, nothing changed: no entries, no new notifications.
    const second = await sweepHype(pool);
    assert.deepEqual(second.entries.filter((id) => skills.includes(id)), []);
    assert.equal(await hypedRows(maint), 1);

    // s3 overtakes s2 → s3 enters, s2 exits.
    await hype(s3, 20, 0, 4);
    const third = await sweepHype(pool);
    assert.ok(third.entries.includes(s3));
    assert.ok(third.exits.includes(s2));
    assert.deepEqual(await openTop(), new Set([s1, s3]));
    assert.equal(await hypedRows(nsAdmin), 3, "s3's entry notifies the namespace admin");

    // s2 re-enters within 7 days: the entry is recorded, the notification is not repeated.
    await hype(s2, 20, 0, 5);
    await hype(s2, 20, 0, 6);
    const fourth = await sweepHype(pool);
    assert.ok(fourth.entries.includes(s2), "s2 re-enters");
    assert.equal(await hypedRows(nsAdmin), 3, "no second skill.hyped for s2 within 7 days");

    // Hard-ineligible: deprecating s2 makes it exit at once.
    await q(`update skills set deprecated_at = now() where id = $1`, [s2]);
    const fifth = await sweepHype(pool);
    assert.ok(fifth.exits.includes(s2), "deprecated skill exits");
    await q(`update skills set deprecated_at = null where id = $1`, [s2]);

    // A lowered top N records the exits.
    await setSetting("hype_top_n", 1);
    await sweepHype(pool);
    assert.equal((await openTop()).size, 1);

    // Kill switch: the sweep skips and touches nothing.
    await setSetting("hype_enabled", false);
    const off = await sweepHype(pool);
    assert.equal(off.skipped, true);
  } finally {
    await setSetting("hype_enabled", true);
    await setSetting("hype_top_n", 5);
    await clean();
    await pool.end();
  }
});
