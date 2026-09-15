// Achievements — the worker's mirror of web's `lib/achievements.ts` award helper (SKILLY_SPEC.md
// §31.2). Same single statement, same combo + Habits + notification rules; kept in sync by hand,
// like `eraseUserByExternalId` mirrors `lib/eraseUser.ts`. The catalog and the pure rules are the
// shared module's, so the two tiers cannot disagree about what a key means.
import type { Pool, PoolClient } from "pg";
import { TRIPLE_THREAT_PARTS, achievementDef, habitKeysFor, isAchievementKey, tripleThreatDue } from "@skilly/shared";

type Db = Pool | PoolClient;

export interface AwardOptions {
  at?: Date;
  backfill?: boolean;
  noHabits?: boolean;
}

/** See web `awardAchievement` — returns the keys NEWLY earned by this call. */
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
    const { rows } = await db.query<{ key: string }>(`select key from user_achievements where user_id = $1`, [userId]);
    const held = rows.map((r) => r.key);
    if (tripleThreatDue(held) && !held.includes("triple_threat")) earned.push(...(await insertKeys(db, userId, ["triple_threat"], at)));
  }
  if (earned.length > 0 && !opts.backfill && (await achievementsEnabledFor(db))) {
    for (const k of earned) {
      const def = achievementDef(k)!;
      await db.query(
        `insert into notifications (user_id, type, payload) values ($1, 'achievement.earned', $2::jsonb)`,
        [userId, JSON.stringify({ key: k, name: def.name, blurb: def.blurb })],
      );
    }
  }
  return earned;
}

/** Best-effort variant for bare-pool write paths: never throws (logs and returns []). */
export async function tryAward(db: Db, userId: string, key: string | null, opts: AwardOptions = {}): Promise<string[]> {
  try {
    return await awardAchievement(db, userId, key, opts);
  } catch (e) {
    console.error(JSON.stringify({ level: "warn", msg: "achievement award failed (non-fatal)", key, err: String(e instanceof Error ? e.message : e) }));
    return [];
  }
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

async function achievementsEnabledFor(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ value: unknown }>(`select value from platform_settings where key = 'achievements_enabled'`);
  return rows[0]?.value !== false;
}
