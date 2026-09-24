// Following people (SKILLY_SPEC.md §35) — the web tier's writes and reads. The fan-out statement,
// the followable predicate and the notification sentences live in @skilly/shared/follows so the
// worker runs the same rules.
import { pool } from "./db";
import { tryAward } from "./achievements";
import { nameSql } from "./userLabel";
import { FOLLOWERS_MILESTONE, followState, followableSql, type FollowState } from "@skilly/shared/follows";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FollowResult =
  | { ok: true; following: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Follow `targetId` (§35.10). Idempotent. 400 for self, 404 for an unknown / erased / inactive
 * target, 409 `follows_disabled` while the target has paused follows. A genuinely new row awards
 * `first_follow` to the follower (a Habits event for them) and — on reaching the milestone —
 * `followers_10` to the followee (NOT a Habits event: the action was someone else's). Both awards
 * are best-effort: the follow insert is a bare statement, like a watch (§31.2).
 */
export async function followUser(followerId: string, targetId: string): Promise<FollowResult> {
  if (!UUID_RE.test(targetId)) return { ok: false, status: 404, error: "not found" };
  if (followerId === targetId) return { ok: false, status: 400, error: "you can't follow yourself" };
  const { rows } = await pool.query<{ status: string; erased_at: Date | null; allow_follows: boolean }>(
    `select status, erased_at, allow_follows from users where id = $1`,
    [targetId],
  );
  const t = rows[0];
  if (!t || t.status !== "active" || t.erased_at !== null) return { ok: false, status: 404, error: "not found" };
  if (!t.allow_follows) return { ok: false, status: 409, error: "follows_disabled" };

  // Re-check followability in the insert itself, so a pause racing this request can't slip a row in.
  const ins = await pool.query(
    `insert into user_follows (follower_id, followee_id)
     select $1, u.id from users u where u.id = $2 and ${followableSql("u")}
     on conflict do nothing`,
    [followerId, targetId],
  );
  if ((ins.rowCount ?? 0) > 0) {
    await tryAward(pool, followerId, "first_follow"); // §35.8 Right Behind You
    if ((await activeFollowerCount(targetId)) >= FOLLOWERS_MILESTONE) {
      await tryAward(pool, targetId, "followers_10", { noHabits: true }); // §35.8 Cult Following
    }
  } else if (!(await isFollowing(followerId, targetId))) {
    // Nothing inserted and no existing row: the target paused (or left) between the two reads.
    return { ok: false, status: 409, error: "follows_disabled" };
  }
  return { ok: true, following: true };
}

/** Unfollow — always allowed whatever the target's state, idempotent (§35.10). */
export async function unfollowUser(followerId: string, targetId: string): Promise<FollowResult> {
  if (!UUID_RE.test(targetId)) return { ok: true, following: false };
  await pool.query(`delete from user_follows where follower_id = $1 and followee_id = $2`, [followerId, targetId]);
  return { ok: true, following: false };
}

export async function isFollowing(followerId: string, targetId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `select 1 from user_follows where follower_id = $1 and followee_id = $2`,
    [followerId, targetId],
  );
  return (rowCount ?? 0) > 0;
}

/** Followers who are active and not erased — the milestone's count (§35.8, ignoring the pause). */
export async function activeFollowerCount(followeeId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from user_follows f
       join users fu on fu.id = f.follower_id and fu.status = 'active' and fu.erased_at is null
      where f.followee_id = $1`,
    [followeeId],
  );
  return rows[0]?.n ?? 0;
}

export interface FollowedUser {
  userId: string;
  displayName: string;
  avatar: string | null;
  /** UTC ISO of when the follow was created. */
  since: string;
  state: FollowState;
}

/** The caller's own list, newest first (§35.5). Erased people never appear (their rows are gone). */
export async function listFollowing(followerId: string): Promise<FollowedUser[]> {
  const { rows } = await pool.query<{
    id: string; label: string; avatar: string | null; created_at: Date; status: string; allow_follows: boolean;
  }>(
    `select u.id, ${nameSql("u.display_name", "u.email")} as label, u.avatar, f.created_at, u.status, u.allow_follows
       from user_follows f
       join users u on u.id = f.followee_id and u.erased_at is null
      where f.follower_id = $1
      order by f.created_at desc, u.id`,
    [followerId],
  );
  return rows.map((r) => ({
    userId: r.id,
    displayName: r.label,
    avatar: r.avatar,
    since: new Date(r.created_at).toISOString(),
    state: followState({ status: r.status, allowFollows: r.allow_follows }),
  }));
}

/** `followable` for a batch of user ids (§35.4) — for payloads that don't select it inline. */
export async function followableMap(userIds: readonly string[]): Promise<Record<string, boolean>> {
  const ids = [...new Set(userIds.filter((id) => UUID_RE.test(id)))];
  if (ids.length === 0) return {};
  const { rows } = await pool.query<{ id: string; followable: boolean }>(
    `select u.id, ${followableSql("u")} as followable from users u where u.id = any($1::uuid[])`,
    [ids],
  );
  const out: Record<string, boolean> = {};
  for (const r of rows) out[r.id] = r.followable === true;
  return out;
}
