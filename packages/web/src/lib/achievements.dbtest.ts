// Live-DB integration test for achievements (SKILLY_SPEC.md §31). Gated behind SKILLY_DB_E2E=1.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Covers: idempotent awards (one row, one notification, ever), the Habits badges evaluated against
// the user's STORED zone (null zone ⇒ never), the triple_threat combo, backfill awards that never
// notify, the platform toggle muting notifications while awards keep recording, the hall read model
// (self / other / hidden / inactive / unknown), the deferred first-timezone backfill, the
// original-proposer rule, and the GDPR erasure sweep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { awardAchievement, getAchievements, setUserTimeZone, isOriginalProposer, achievementCountForCard } from "./achievements";
import { eraseUser } from "./eraseUser";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

// 2026-09-12 is a Saturday; 00:00Z = 03:00 in Sofia (EEST) ⇒ Night Shift + Weekend Warrior there.
const SAT_NIGHT_SOFIA = new Date("2026-09-12T00:00:00Z");

async function mkUser(oid: string, timeZone: string | null): Promise<string> {
  const id = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status) values ($1,$2,$3,'active')
     on conflict (entra_object_id) do update set email = excluded.email, status = 'active', erased_at = null returning id`,
    [oid, `${oid}@org`, oid],
  )).rows[0]!.id;
  await pool.query(`update users set time_zone = $2, achievements_hidden = false where id = $1`, [id, timeZone]);
  await pool.query(`delete from user_achievements where user_id = $1`, [id]);
  await pool.query(`delete from notifications where user_id = $1`, [id]);
  return id;
}

const notifCount = async (userId: string) =>
  Number((await pool.query<{ n: string }>(`select count(*)::text as n from notifications where user_id = $1 and type = 'achievement.earned'`, [userId])).rows[0]!.n);
const heldKeys = async (userId: string) =>
  (await pool.query<{ key: string }>(`select key from user_achievements where user_id = $1 order by key`, [userId])).rows.map((r) => r.key);

test("achievements: idempotent awards, Habits by stored zone, combo, backfill + toggle gating", { skip: !enabled }, async () => {
  const sofia = await mkUser("ach-sofia", "Europe/Sofia");
  const nozone = await mkUser("ach-nozone", null);
  await pool.query(`delete from platform_settings where key = 'achievements_enabled'`);
  try {
    // Saturday 03:00 local ⇒ the badge itself plus both Habits badges, one notification each.
    const first = await awardAchievement(pool, sofia, "first_watch", { at: SAT_NIGHT_SOFIA });
    assert.deepEqual(first.sort(), ["first_watch", "night_shift", "weekend_warrior"]);
    assert.equal(await notifCount(sofia), 3);
    // Again: nothing new, no second notification, no duplicate row.
    assert.deepEqual(await awardAchievement(pool, sofia, "first_watch", { at: SAT_NIGHT_SOFIA }), []);
    assert.equal(await notifCount(sofia), 3);
    assert.deepEqual(await heldKeys(sofia), ["first_watch", "night_shift", "weekend_warrior"]);
    // A Habits-only event (null key) on a repeat action: nothing new here (already held), but a
    // weekday-daytime event for a fresh user is a clean no-op.
    assert.deepEqual(await awardAchievement(pool, sofia, null, { at: SAT_NIGHT_SOFIA }), []);

    // No stored zone ⇒ the Habits badges never fire, whatever the instant.
    assert.deepEqual(await awardAchievement(pool, nozone, "first_watch", { at: SAT_NIGHT_SOFIA }), ["first_watch"]);
    assert.equal(await notifCount(nozone), 1);

    // triple_threat completes on whichever channel badge lands last.
    assert.deepEqual(await awardAchievement(pool, nozone, "first_install"), ["first_install"]);
    assert.deepEqual(await awardAchievement(pool, nozone, "first_marketplace"), ["first_marketplace"]);
    assert.deepEqual(await awardAchievement(pool, nozone, "first_mcp"), ["first_mcp", "triple_threat"]);
    assert.equal(await notifCount(nozone), 5);

    // A backfill award records the row (with the original instant) but never notifies.
    const when = new Date("2025-01-15T10:00:00Z");
    assert.deepEqual(await awardAchievement(pool, nozone, "first_rating", { at: when, backfill: true }), ["first_rating"]);
    assert.equal(await notifCount(nozone), 5);
    const earnedAt = (await pool.query<{ earned_at: Date }>(`select earned_at from user_achievements where user_id = $1 and key = 'first_rating'`, [nozone])).rows[0]!.earned_at;
    assert.equal(earnedAt.toISOString(), when.toISOString());

    // Platform toggle off: awards keep recording, notifications stop (dormant-not-destructive).
    await pool.query(`insert into platform_settings (key, value) values ('achievements_enabled', 'false'::jsonb) on conflict (key) do update set value = excluded.value`);
    assert.deepEqual(await awardAchievement(pool, nozone, "onboarded"), ["onboarded"]);
    assert.equal(await notifCount(nozone), 5);
    assert.equal(await achievementCountForCard(nozone), null); // the hover-card line hides while off
    await pool.query(`delete from platform_settings where key = 'achievements_enabled'`);
    assert.equal(await achievementCountForCard(nozone), 7);

    // An unknown key is a programming error, never a silent row.
    await assert.rejects(() => awardAchievement(pool, nozone, "installs_10"), /unknown achievement key/);

    // The notification payload is human-usable (key + name) so the in-app row and toast can render.
    const payload = (await pool.query<{ payload: { key: string; name: string } }>(
      `select payload from notifications where user_id = $1 and type = 'achievement.earned' order by created_at limit 1`, [sofia],
    )).rows[0]!.payload;
    assert.equal(payload.key, "first_watch");
    assert.equal(payload.name, "Stalker, but Nicely");
  } finally {
    await pool.query(`delete from platform_settings where key = 'achievements_enabled'`);
  }
});

test("achievements: hall read model — self / other / hidden / inactive / unknown", { skip: !enabled }, async () => {
  const owner = await mkUser("ach-owner", null);
  const viewer = await mkUser("ach-viewer", null);
  await awardAchievement(pool, owner, "first_request", { backfill: true });
  await awardAchievement(pool, owner, "first_message", { backfill: true });

  const asViewer = await getAchievements(owner, viewer);
  assert.ok(asViewer);
  assert.equal(asViewer.hidden, false);
  assert.deepEqual(asViewer.earned.map((e) => e.key).sort(), ["first_message", "first_request"]);
  assert.equal(asViewer.total, 20);
  assert.equal(await achievementCountForCard(owner), 2);

  // Opt-out: others get the private shape; the owner still sees everything.
  await pool.query(`update users set achievements_hidden = true where id = $1`, [owner]);
  const hidden = await getAchievements(owner, viewer);
  assert.ok(hidden);
  assert.equal(hidden.hidden, true);
  assert.deepEqual(hidden.earned, []);
  assert.equal(await achievementCountForCard(owner), null);
  const self = await getAchievements(owner, owner);
  assert.ok(self);
  assert.equal(self.hidden, false);
  assert.equal(self.earned.length, 2);
  await pool.query(`update users set achievements_hidden = false where id = $1`, [owner]);

  // A user with nothing earned has no hover-card line (count null), but a hall (empty).
  assert.equal(await achievementCountForCard(viewer), null);

  // Deprovisioned ⇒ 404 while inactive; re-enabling restores the hall unchanged.
  await pool.query(`update users set status = 'inactive' where id = $1`, [owner]);
  assert.equal(await getAchievements(owner, viewer), null);
  await pool.query(`update users set status = 'active' where id = $1`, [owner]);
  assert.equal((await getAchievements(owner, viewer))?.earned.length, 2);

  // Unknown id ⇒ null.
  assert.equal(await getAchievements("00000000-0000-0000-0000-000000000000", viewer), null);
});

test("achievements: first timezone capture backfills Night Shift / Weekend Warrior silently, once", { skip: !enabled }, async () => {
  const u = await mkUser("ach-tz", null);
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ('ach-ns','ach-ns',false)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  )).rows[0]!.id;
  const skill = (await pool.query<{ id: string }>(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
     values ($1,'ach-skill','Ach','d','claude','hosted','org')
     on conflict (namespace_id, slug) do update set title = excluded.title returning id`,
    [ns],
  )).rows[0]!.id;
  await pool.query(`delete from skill_watches where user_id = $1`, [u]);
  // History: one watch on a Saturday at 03:00 Sofia time (but 00:00Z — a UTC-based rule would miss it).
  await pool.query(`insert into skill_watches (user_id, skill_id, created_at) values ($1, $2, $3)`, [u, skill, SAT_NIGHT_SOFIA]);

  const first = await setUserTimeZone(u, "Europe/Sofia");
  assert.equal(first.firstCapture, true);
  assert.deepEqual(first.awarded.sort(), ["night_shift", "weekend_warrior"]);
  assert.equal(await notifCount(u), 0); // a backfill never notifies
  const tz = (await pool.query<{ time_zone: string }>(`select time_zone from users where id = $1`, [u])).rows[0]!.time_zone;
  assert.equal(tz, "Europe/Sofia");
  // The earned instant is the historical event, not "now".
  const at = (await pool.query<{ earned_at: Date }>(`select earned_at from user_achievements where user_id = $1 and key = 'night_shift'`, [u])).rows[0]!.earned_at;
  assert.equal(at.toISOString(), SAT_NIGHT_SOFIA.toISOString());

  // A later zone change stores the zone but never re-runs history.
  await pool.query(`delete from user_achievements where user_id = $1`, [u]);
  const second = await setUserTimeZone(u, "America/New_York");
  assert.equal(second.firstCapture, false);
  assert.deepEqual(second.awarded, []);
  assert.deepEqual(await heldKeys(u), []);
});

test("achievements: original-proposer rule + GDPR erasure sweep", { skip: !enabled }, async () => {
  const proposer = await mkUser("ach-proposer", "UTC");
  const other = await mkUser("ach-other", null);
  const admin = await mkUser("ach-admin", null);
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ('ach-ns','ach-ns',false)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  )).rows[0]!.id;
  const skill = (await pool.query<{ id: string }>(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
     values ($1,'ach-origin','Origin','d','claude','hosted','org')
     on conflict (namespace_id, slug) do update set title = excluded.title returning id`,
    [ns],
  )).rows[0]!.id;
  await pool.query(`delete from skill_versions where skill_id = $1`, [skill]);
  await pool.query(
    `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by)
     values ($1, '1.0.0', false, 'active', 'ach/origin/1.0.0.tgz', 'sha', $2)`,
    [skill, proposer],
  );
  assert.equal(await isOriginalProposer(pool, skill, proposer), true);
  assert.equal(await isOriginalProposer(pool, skill, other), false);

  // Erasure deletes the rows and resets the two preference/zone columns.
  await awardAchievement(pool, proposer, "first_published", { backfill: true });
  await pool.query(`update users set achievements_hidden = true where id = $1`, [proposer]);
  assert.equal((await heldKeys(proposer)).length, 1);
  await eraseUser(admin, proposer, null);
  assert.deepEqual(await heldKeys(proposer), []);
  const row = (await pool.query<{ achievements_hidden: boolean; time_zone: string | null }>(
    `select achievements_hidden, time_zone from users where id = $1`, [proposer],
  )).rows[0]!;
  assert.equal(row.achievements_hidden, false);
  assert.equal(row.time_zone, null);
  // A tombstone has no hall.
  assert.equal(await getAchievements(proposer, other), null);
});
