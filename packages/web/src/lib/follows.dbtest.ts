// Live-DB integration test for following people (SKILLY_SPEC.md §35). Gated behind SKILLY_DB_E2E=1.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Covers: follow / unfollow idempotency and the 400 / 404 / 409 rules; unfollow always allowed;
// first_follow + followers_10 awarded once and never revoked; the shared fan-out's visibility gate,
// dedup exclusion, pause and status filters; follow.request_created / follow.request_fulfilled from
// the real request paths; follow.achievement (and its achievements_hidden + backfill silences); the
// "People I follow" states; the leaderboard followers metric (and the pause reading 0); `followable`
// on the card; and the GDPR erasure sweep deleting follows in both directions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fanOutToFollowers } from "@skilly/shared/follows";
import { pool } from "./db";
import { followUser, unfollowUser, listFollowing, activeFollowerCount } from "./follows";
import { awardAchievement } from "./achievements";
import { createRequest, fulfilWithExistingSkill } from "./requests";
import { getLeaderboard } from "./leaderboard";
import { getUserCard } from "./directory";
import { eraseUser } from "./eraseUser";

const enabled = process.env.SKILLY_DB_E2E === "1";
const P = "fol";

/** Upsert a fresh-state active user (users can't be deleted — audit rows reference them). */
async function mkUser(tag: string): Promise<string> {
  const oid = `${P}-${tag}`;
  const id = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status) values ($1,$2,$3,'active')
     on conflict (entra_object_id) do update set email = excluded.email, display_name = excluded.display_name, status = 'active', erased_at = null
     returning id`,
    [oid, `${oid}@org`, oid],
  )).rows[0]!.id;
  await pool.query(`update users set allow_follows = true, achievements_hidden = false, leaderboard_hidden = false where id = $1`, [id]);
  await pool.query(`delete from user_follows where follower_id = $1 or followee_id = $1`, [id]);
  await pool.query(`delete from user_achievements where user_id = $1`, [id]);
  await pool.query(`delete from notifications where user_id = $1`, [id]);
  await pool.query(`delete from group_memberships where user_id = $1`, [id]);
  return id;
}

const rowsOf = async (userId: string, type: string) =>
  (await pool.query<{ payload: Record<string, unknown> }>(`select payload from notifications where user_id = $1 and type = $2 order by created_at`, [userId, type])).rows.map((r) => r.payload);
const held = async (userId: string) =>
  (await pool.query<{ key: string }>(`select key from user_achievements where user_id = $1 order by key`, [userId])).rows.map((r) => r.key);

test("follows: follow/unfollow rules, idempotency, pause and inactive targets", { skip: !enabled }, async () => {
  const a = await mkUser("a");
  const b = await mkUser("b");
  assert.deepEqual(await followUser(a, a), { ok: false, status: 400, error: "you can't follow yourself" });
  assert.deepEqual(await followUser(a, "00000000-0000-0000-0000-000000000000"), { ok: false, status: 404, error: "not found" });
  assert.deepEqual(await followUser(a, "not-a-uuid"), { ok: false, status: 404, error: "not found" });

  assert.deepEqual(await followUser(a, b), { ok: true, following: true });
  assert.deepEqual(await followUser(a, b), { ok: true, following: true }, "idempotent");
  assert.equal(Number((await pool.query(`select count(*) from user_follows where follower_id = $1`, [a])).rows[0].count), 1);

  // Pause: new follows are refused, the existing row is kept, and unfollow still works.
  const c = await mkUser("c");
  await pool.query(`update users set allow_follows = false where id = $1`, [b]);
  assert.deepEqual(await followUser(c, b), { ok: false, status: 409, error: "follows_disabled" });
  assert.equal((await listFollowing(a))[0]!.state, "paused");
  // Inactive target: 404 to follow, listed as Inactive, unfollow allowed.
  await pool.query(`update users set allow_follows = true, status = 'inactive' where id = $1`, [b]);
  assert.equal((await followUser(c, b) as { status: number }).status, 404);
  assert.equal((await listFollowing(a))[0]!.state, "inactive");
  assert.deepEqual(await unfollowUser(a, b), { ok: true, following: false });
  assert.deepEqual(await unfollowUser(a, b), { ok: true, following: false }, "idempotent");
  assert.deepEqual(await listFollowing(a), []);
  await pool.query(`update users set status = 'active' where id = $1`, [b]);
});

test("follows: first_follow + followers_10 are awarded once and never revoked", { skip: !enabled }, async () => {
  const star = await mkUser("star");
  const fans: string[] = [];
  for (let i = 0; i < 10; i++) fans.push(await mkUser(`fan${i}`));
  for (const f of fans.slice(0, 9)) await followUser(f, star);
  assert.ok((await held(fans[0]!)).includes("first_follow"));
  assert.ok(!(await held(star)).includes("followers_10"), "9 followers is not the milestone");
  await followUser(fans[9]!, star);
  assert.equal(await activeFollowerCount(star), 10);
  assert.ok((await held(star)).includes("followers_10"));
  // The followee's milestone is not a Habits event for them (the action was someone else's).
  assert.ok(!(await held(star)).some((k) => k === "night_shift" || k === "weekend_warrior"));
  // Falling below 10 keeps the badge.
  await unfollowUser(fans[9]!, star);
  assert.ok((await held(star)).includes("followers_10"));
  // An inactive follower doesn't count toward the milestone / metric.
  await pool.query(`update users set status = 'inactive' where id = $1`, [fans[0]]);
  assert.equal(await activeFollowerCount(star), 8);
  await pool.query(`update users set status = 'active' where id = $1`, [fans[0]]);
});

test("follows: the fan-out gate — visibility, dedup, pause, inactive followers", { skip: !enabled }, async () => {
  const actor = await mkUser("actor");
  const insider = await mkUser("insider");
  const outsider = await mkUser("outsider");
  const watcher = await mkUser("watcher");
  const sleeper = await mkUser("sleeper");
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ($1,$1,false)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
    [`${P}-ns`],
  )).rows[0]!.id;
  const grp = (await pool.query<{ id: string }>(
    `insert into groups (entra_object_id, display_name) values ($1,$1)
     on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
    [`${P}-grp`],
  )).rows[0]!.id;
  await pool.query(`delete from role_mappings where group_id = $1`, [grp]);
  await pool.query(`insert into role_mappings (group_id, namespace_id, role) values ($1,$2,'namespace_member')`, [grp, ns]);
  await pool.query(`insert into group_memberships (group_id, user_id) values ($1,$2) on conflict do nothing`, [grp, insider]);
  for (const f of [insider, outsider, watcher, sleeper]) await followUser(f, actor);
  await pool.query(`update users set status = 'inactive' where id = $1`, [sleeper]);

  const publish = (excludeUserIds: string[] = []) =>
    fanOutToFollowers(pool, {
      type: "follow.new_skill",
      actorId: actor,
      payload: { namespaceSlug: `${P}-ns`, skillSlug: "restricted", semver: "1.0.0" },
      skill: { namespaceId: ns, visibility: "namespace" },
      excludeUserIds,
    });
  await publish([watcher]); // the watcher already got skill.new_version for this publish
  assert.equal((await rowsOf(insider, "follow.new_skill")).length, 1, "a follower in the namespace hears about it");
  assert.equal((await rowsOf(outsider, "follow.new_skill")).length, 0, "a follower who can't see the skill hears nothing (invariant #3)");
  assert.equal((await rowsOf(watcher, "follow.new_skill")).length, 0, "the watch notification for the same event wins");
  assert.equal((await rowsOf(sleeper, "follow.new_skill")).length, 0, "inactive followers are skipped");
  const payload = (await rowsOf(insider, "follow.new_skill"))[0]!;
  assert.equal(payload.actorId, actor);
  assert.equal(payload.actorName, `${P}-actor`);

  // Org-visible reaches every active follower; a paused actor reaches nobody.
  await fanOutToFollowers(pool, { type: "follow.new_version", actorId: actor, payload: {}, skill: { namespaceId: ns, visibility: "org" } });
  assert.equal((await rowsOf(outsider, "follow.new_version")).length, 1);
  await pool.query(`update users set allow_follows = false where id = $1`, [actor]);
  await fanOutToFollowers(pool, { type: "follow.new_version", actorId: actor, payload: {}, skill: { namespaceId: ns, visibility: "org" } });
  assert.equal((await rowsOf(outsider, "follow.new_version")).length, 1, "paused: no new rows");
  await pool.query(`update users set allow_follows = true, status = 'active' where id in ($1, $2)`, [actor, sleeper]);
});

test("follows: request and achievement events reach followers through the real write paths", { skip: !enabled }, async () => {
  const actor = await mkUser("req-actor");
  const requester = await mkUser("req-requester");
  const fan = await mkUser("req-fan");
  await followUser(fan, actor);
  await followUser(requester, actor);

  const created = await createRequest(actor, { title: `${P} pdf tools`, description: "Please build this", toolHarness: "generic", categories: [] });
  assert.ok("id" in created);
  const got = await rowsOf(fan, "follow.request_created");
  assert.equal(got.length, 1);
  assert.equal(got[0]!.requestId, (created as { id: string }).id);

  // Fulfilment: the fan hears; the requester (who follows the fulfiller) gets request.fulfilled only.
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ($1,$1,false)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
    [`${P}-orgns`],
  )).rows[0]!.id;
  await pool.query(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
     values ($1,'existing','Existing','d','generic','hosted','org','active')
     on conflict (namespace_id, slug) do update set status = 'active', visibility = 'org'`,
    [ns],
  );
  const req = await createRequest(requester, { title: `${P} wanted`, description: "Wanted", toolHarness: "generic", categories: [] });
  const r = await fulfilWithExistingSkill(actor, (req as { id: string }).id, `${P}-orgns`, "existing");
  assert.deepEqual(r, { ok: true });
  assert.equal((await rowsOf(fan, "follow.request_fulfilled")).length, 1);
  assert.equal((await rowsOf(requester, "follow.request_fulfilled")).length, 0, "the requester's own notification wins");
  assert.equal((await rowsOf(requester, "request.fulfilled")).length, 1);

  // Achievements: fan-out rides achievement.earned; a backfill and achievements_hidden are silent.
  await pool.query(`delete from notifications where user_id = $1 and type = 'follow.achievement'`, [fan]);
  await awardAchievement(pool, actor, "first_rating", { noHabits: true });
  const badges = await rowsOf(fan, "follow.achievement");
  assert.ok(badges.some((p) => p.badgeKey === "first_rating" && p.badgeName === "Critic"));
  const before = (await rowsOf(fan, "follow.achievement")).length;
  await awardAchievement(pool, actor, "first_watch", { noHabits: true, backfill: true });
  await pool.query(`update users set achievements_hidden = true where id = $1`, [actor]);
  await awardAchievement(pool, actor, "onboarded", { noHabits: true });
  assert.equal((await rowsOf(fan, "follow.achievement")).length, before, "backfill + hidden trophies notify nobody");
  await pool.query(`update users set achievements_hidden = false where id = $1`, [actor]);
});

test("follows: leaderboard followers metric, the pause reading 0, and `followable` on the card", { skip: !enabled }, async () => {
  const star = await mkUser("lb-star");
  for (let i = 0; i < 3; i++) await followUser(await mkUser(`lb-fan${i}`), star);
  const board = await getLeaderboard("all", "followed", { bypassCache: true });
  const row = board.find((e) => e.userId === star);
  assert.ok(row, "a user whose only standing is followers appears on the board");
  assert.equal(row!.followers, 3);
  assert.equal(row!.followable, true);
  assert.equal((await getLeaderboard("30d", "followed", { bypassCache: true })).find((e) => e.userId === star)?.followers, 3);
  assert.equal((await getUserCard(star))!.followable, true);

  await pool.query(`update users set allow_follows = false where id = $1`, [star]);
  assert.equal((await getLeaderboard("all", "followed", { bypassCache: true })).find((e) => e.userId === star), undefined, "paused: followers read 0");
  assert.equal((await getUserCard(star))!.followable, false);
  await pool.query(`update users set allow_follows = true where id = $1`, [star]);
});

test("follows: GDPR erasure deletes follows in both directions and resets allow_follows", { skip: !enabled }, async () => {
  const admin = await mkUser("erase-admin");
  const victim = await mkUser("erase-victim");
  const other = await mkUser("erase-other");
  await followUser(victim, other);
  await followUser(other, victim);
  await pool.query(`update users set allow_follows = false where id = $1`, [victim]);
  const res = await eraseUser(admin, victim, null);
  assert.equal((res as { ok: boolean }).ok, true);
  const n = Number((await pool.query(`select count(*) from user_follows where follower_id = $1 or followee_id = $1`, [victim])).rows[0].count);
  assert.equal(n, 0);
  assert.equal((await pool.query<{ allow_follows: boolean }>(`select allow_follows from users where id = $1`, [victim])).rows[0]!.allow_follows, true);
  assert.deepEqual(await listFollowing(other), []);
  // Erasure detached the oid, so the next run's mkUser("erase-victim") simply provisions a fresh account.
});
