// Achievements — the award helper, the per-user read model and the deferred timezone backfill
// (SKILLY_SPEC.md §31). The catalog and the pure rules live in @skilly/shared/achievements; this
// module owns the SQL. The worker mirrors `awardAchievement` (packages/worker/src/achievements.ts)
// for the hooks that live there — keep the two in sync.
import type { Pool, PoolClient } from "pg";
import { pool } from "./db";
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_TOTAL,
  TRIPLE_THREAT_PARTS,
  achievementDef,
  habitKeysFor,
  isAchievementKey,
  tripleThreatDue,
} from "@skilly/shared/achievements";

type Db = Pool | PoolClient;

export interface AwardOptions {
  /** The event instant (defaults to now). Backfills pass the original event's timestamp. */
  at?: Date;
  /** A backfill never notifies (§31.6 / §31.3). */
  backfill?: boolean;
  /** Skip the Habits evaluation (used by the deferred backfill, which evaluates them itself). */
  noHabits?: boolean;
}

/**
 * Award `key` (or nothing but the Habits badges when `key` is null — every hook point is a Habits
 * event, §31.2) to `userId`, inside the caller's transaction. Idempotent on the PK: a badge already
 * held is a no-op. Returns the keys that were NEWLY earned by this call. On a genuinely new badge it
 * also re-evaluates `triple_threat`, stamps `users.hero_at` when the award completes the catalog
 * (§31.10 — this runs on backfills too, so a long-standing full-house user gets a real Hero date)
 * and, unless this is a backfill or the platform toggle is off, writes one `achievement.earned`
 * notification per new key, carrying the level the award moved the user to (§31.4).
 *
 * Never does I/O beyond its own inserts, so the realistic failure mode is a DB error the caller
 * would have hit anyway; a thrown error rolls the caller's transaction back with it.
 */
export async function awardAchievement(db: Db, userId: string, key: string | null, opts: AwardOptions = {}): Promise<string[]> {
  if (key !== null && !isAchievementKey(key)) throw new Error(`unknown achievement key: ${key}`);
  const at = opts.at ?? new Date();
  const keys: string[] = key ? [key] : [];
  if (!opts.noHabits) {
    const { rows } = await db.query<{ time_zone: string | null }>(`select time_zone from users where id = $1`, [userId]);
    keys.push(...habitKeysFor(at, rows[0]?.time_zone ?? null));
  }
  if (keys.length === 0) return [];
  const earned = await insertKeys(db, userId, keys, at);
  if (earned.some((k) => (TRIPLE_THREAT_PARTS as readonly string[]).includes(k))) {
    const held = await heldKeys(db, userId);
    if (tripleThreatDue(held) && !held.includes("triple_threat")) earned.push(...(await insertKeys(db, userId, ["triple_threat"], at)));
  }
  if (earned.length === 0) return earned;
  // §31.10: the level is just the count, and Hero is stamped the first time it covers the catalog.
  // Outside the notification guard on purpose — a backfilled award must still stamp Hero, it just
  // must not announce it.
  const level = (await heldKeys(db, userId)).length;
  const hero = await stampHero(db, userId, level >= ACHIEVEMENT_TOTAL, at);
  if (!opts.backfill && (await achievementsEnabledFor(db))) {
    for (const k of earned) {
      const def = achievementDef(k)!;
      await db.query(
        `insert into notifications (user_id, type, payload) values ($1, 'achievement.earned', $2::jsonb)`,
        [userId, JSON.stringify({ key: k, name: def.name, blurb: def.blurb, level, total: ACHIEVEMENT_TOTAL, hero })],
      );
    }
  }
  return earned;
}

/**
 * Best-effort award for hook points whose write is NOT inside a transaction (a bare pool write):
 * the user's action has already succeeded, so a failure here is logged and swallowed — the badge
 * is simply picked up by the next qualifying event (§31.2).
 */
export async function tryAward(db: Db, userId: string, key: string | null, opts: AwardOptions = {}): Promise<string[]> {
  try {
    return await awardAchievement(db, userId, key, opts);
  } catch (e) {
    console.error(JSON.stringify({ level: "warn", msg: "achievement award failed (non-fatal)", key, err: String(e instanceof Error ? e.message : e) }));
    return [];
  }
}

/** The skill's original proposer = the creator of its earliest version (§31.1 `maintainer_added`). */
export async function isOriginalProposer(db: Db, skillId: string, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ created_by: string | null }>(
    `select created_by from skill_versions where skill_id = $1 order by created_at, id limit 1`,
    [skillId],
  );
  return rows[0]?.created_by === userId;
}

/** Convenience for hook points that only need to register a Habits event (a repeat action). */
export function touchAchievementEvent(db: Db, userId: string, at?: Date): Promise<string[]> {
  return awardAchievement(db, userId, null, { at });
}

async function insertKeys(db: Db, userId: string, keys: string[], at: Date): Promise<string[]> {
  const { rows } = await db.query<{ key: string }>(
    `insert into user_achievements (user_id, key, earned_at)
     select $1, k, $3 from unnest($2::text[]) as k
     on conflict do nothing
     returning key`,
    [userId, keys, at],
  );
  return rows.map((r) => r.key);
}

async function heldKeys(db: Db, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ key: string }>(`select key from user_achievements where user_id = $1`, [userId]);
  return rows.map((r) => r.key);
}

/**
 * Stamp `users.hero_at` when `complete` and it is still null, and report whether the user is a Hero
 * afterwards (§31.10). One statement, so the stamp lands in the caller's transaction with the badge
 * that earned it. `coalesce` makes it write-once: a later catalog addition never re-stamps, and
 * nothing here can ever clear it — that permanence is the whole point of the column.
 */
async function stampHero(db: Db, userId: string, complete: boolean, at: Date): Promise<boolean> {
  const { rows } = await db.query<{ hero_at: Date | null }>(
    `update users set hero_at = case when $2::boolean then coalesce(hero_at, $3) else hero_at end
      where id = $1
      returning hero_at`,
    [userId, complete, at],
  );
  return rows[0]?.hero_at != null;
}

// The toggle is read per award (one tiny indexed query); the admin surfaces read the same row.
async function achievementsEnabledFor(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ value: unknown }>(`select value from platform_settings where key = 'achievements_enabled'`);
  return rows[0]?.value !== false;
}

// ---------------------------------------------------------------------------------------------
// Read model (§31.8)
// ---------------------------------------------------------------------------------------------

export interface EarnedBadge { key: string; earnedAt: string }

export interface AchievementsView {
  userId: string;
  displayName: string;
  avatar: string | null;
  /** True when the target opted out and the viewer is not the target: `earned` is then empty. */
  hidden: boolean;
  earned: EarnedBadge[];
  total: number;
  /** §31.10 — when they first held the whole catalog, or null. Never derived from `earned.length`
   *  (a grown catalog must not un-Hero anyone); null while `hidden`, like the badges themselves. */
  heroAt: string | null;
}

/**
 * The hall payload for `targetId` as seen by `viewerId`. Null = 404 (unknown, erased, or
 * inactive — consistent with the leaderboard hiding deprovisioned users, §31.5).
 */
export async function getAchievements(targetId: string, viewerId: string, db: Db = pool): Promise<AchievementsView | null> {
  const { rows } = await db.query<{ id: string; display_name: string; avatar: string | null; hidden: boolean; hero_at: Date | null }>(
    `select id, display_name, avatar, achievements_hidden as hidden, hero_at
       from users where id = $1 and erased_at is null and status = 'active'`,
    [targetId],
  );
  const u = rows[0];
  if (!u) return null;
  const hidden = u.hidden && viewerId !== targetId;
  const earned = hidden
    ? []
    : (
        await db.query<{ key: string; earned_at: Date }>(
          `select key, earned_at from user_achievements where user_id = $1 order by earned_at desc, key`,
          [targetId],
        )
      ).rows
        .filter((r) => isAchievementKey(r.key))
        .map((r) => ({ key: r.key, earnedAt: r.earned_at.toISOString() }));
  return {
    userId: u.id,
    displayName: u.display_name,
    avatar: u.avatar,
    hidden,
    earned,
    total: ACHIEVEMENTS.length,
    // Hidden from a non-self viewer means hidden entirely: the level bar and the "Hero since" line
    // would restate the very count the opt-out exists to withhold (§31.5).
    heroAt: hidden ? null : (u.hero_at?.toISOString() ?? null),
  };
}

/**
 * The hover-card count (§31.5): the number of badges, or null when the card must not show the line
 * (opted out, none earned, or the platform toggle is off). One indexed count.
 */
export async function achievementCountForCard(targetId: string, db: Db = pool): Promise<number | null> {
  const { rows } = await db.query<{ hidden: boolean; n: string; enabled: boolean }>(
    `select u.achievements_hidden as hidden,
            (select count(*) from user_achievements ua where ua.user_id = u.id) as n,
            coalesce((select value from platform_settings where key = 'achievements_enabled') <> 'false'::jsonb, true) as enabled
       from users u where u.id = $1`,
    [targetId],
  );
  const r = rows[0];
  if (!r || r.hidden || !r.enabled) return null;
  const n = Number(r.n);
  return n > 0 ? n : null;
}

// ---------------------------------------------------------------------------------------------
// Timezone capture + the deferred Habits backfill (§31.3)
// ---------------------------------------------------------------------------------------------

/**
 * Store a validated IANA zone for the user. When this is the FIRST zone ever recorded (the column
 * was NULL), the user's history is run once through the Night Shift / Weekend Warrior rules — the
 * same event sources the migration's backfill used — awarding silently (no notification). A later
 * zone change does not re-run history (§31.3).
 */
export async function setUserTimeZone(userId: string, timeZone: string, db: Pool = pool): Promise<{ firstCapture: boolean; awarded: string[] }> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ prev: string | null }>(
      `update users set time_zone = $2 where id = $1 returning (select time_zone from users u0 where u0.id = $1) as prev`,
      [userId, timeZone],
    );
    // The RETURNING subquery sees the pre-update snapshot, so `prev` is the previous value.
    const prev = rows[0]?.prev ?? null;
    let awarded: string[] = [];
    if (rows.length > 0 && prev === null) awarded = await backfillHabits(client, userId, timeZone);
    await client.query("commit");
    return { firstCapture: rows.length > 0 && prev === null, awarded };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Every historical event instant for the user, across the §31.6 sources (ascending). */
async function historicalEventTimes(db: Db, userId: string): Promise<Date[]> {
  const { rows } = await db.query<{ at: Date }>(
    `select at from (
        select first_at as at from skill_installs where user_id = $1
        union all select created_at from tokens where user_id = $1 and type = 'marketplace' and last_served_commit is not null
        union all select created_at from oauth_grants where user_id = $1 and last_used_at is not null
        union all select created_at from skill_requests where requester_user_id = $1
        union all select fulfilled_at from skill_requests where fulfilled_by_user_id = $1 and fulfilled_at is not null and requester_user_id <> $1
        union all select created_at from proposals where submitted_by = $1
        union all select created_at from skill_versions where created_by = $1
        union all select created_at from skill_maintainers where user_id = $1
        union all select created_at from messages where author_id = $1
        union all select created_at from skill_watches where user_id = $1
        union all select created_at from skill_ratings where user_id = $1
        union all select onboarded_at from users where id = $1 and onboarded_at is not null
     ) e where at is not null order by at`,
    [userId],
  );
  return rows.map((r) => r.at);
}

async function backfillHabits(db: Db, userId: string, timeZone: string): Promise<string[]> {
  const times = await historicalEventTimes(db, userId);
  const earliest = new Map<string, Date>();
  for (const t of times) {
    for (const k of habitKeysFor(t, timeZone)) if (!earliest.has(k)) earliest.set(k, t);
    if (earliest.size === 2) break;
  }
  const out: string[] = [];
  for (const [k, t] of earliest) out.push(...(await awardAchievement(db, userId, k, { at: t, backfill: true, noHabits: true })));
  return out;
}
