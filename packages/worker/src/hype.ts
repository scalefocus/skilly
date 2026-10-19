// The hype sweep (SKILLY_SPEC.md §50.5) — leader-only, every 3 hours plus once at start. It is the
// only writer of `skill_hype_top`: it recomputes the board, records which skills ENTER and LEAVE the
// top N, and on each entry notifies the skill's maintainers (`skill.hyped`, at most once per skill per
// 7 days, §50.7) and awards `hype_train` to its effective maintainers and `talent_scout` to everyone
// holding an in-window hype on it (§50.9). Under a rolling window there is no "end of week", so this
// sweep is the one documented exception to §31.2's "awards are inline, never a sweep".
//
// The board query and the effective-maintainer set come from `@skilly/shared/hype`, so the sweep and
// the web tier always agree on the order and on who maintains what.
import type { Pool, PoolClient } from "pg";
import {
  HYPE_SETTING_KEYS,
  HYPE_WINDOW_SQL,
  coerceHypeSettings,
  effectiveMaintainerIdsSql,
  hypeBoardSql,
  type HypeSettings,
} from "@skilly/shared";
import { awardAchievement } from "./achievements.js";

/** Default cadence (§50.1 decision 11). `HYPE_SWEEP_INTERVAL_MS` overrides it. */
export const HYPE_SWEEP_INTERVAL_MS = 3 * 60 * 60 * 1000;

/** The advisory-lock key, so an overlapping run (a second replica, a manual run) skips. */
const LOCK_KEY = "hype-sweep";

export async function getHypeSettings(db: Pool | PoolClient): Promise<HypeSettings> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    `select key, value from platform_settings where key = any($1::text[])`,
    [Object.values(HYPE_SETTING_KEYS)],
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return coerceHypeSettings((k) => map.get(k));
}

export interface HypeSweepResult {
  skipped: boolean;
  entries: string[];
  exits: string[];
  notified: number;
}

/** One pass. Returns the skill ids that entered and left the top N. */
export async function sweepHype(pool: Pool): Promise<HypeSweepResult> {
  const settings = await getHypeSettings(pool);
  if (!settings.enabled) return { skipped: true, entries: [], exits: [], notified: 0 };

  const lockClient = await pool.connect();
  try {
    const { rows: lock } = await lockClient.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtext($1)) as ok`, [LOCK_KEY]);
    if (!lock[0]?.ok) return { skipped: true, entries: [], exits: [], notified: 0 };
    try {
      return await runSweep(pool, settings);
    } finally {
      await lockClient.query(`select pg_advisory_unlock(hashtext($1))`, [LOCK_KEY]);
    }
  } finally {
    lockClient.release();
  }
}

async function runSweep(pool: Pool, settings: HypeSettings): Promise<HypeSweepResult> {
  const { rows: board } = await pool.query<{
    skill_id: string; namespace_slug: string; skill_slug: string; score: number; hype_count: number;
  }>(hypeBoardSql(1), [settings.topN]);
  const incoming = board.map((r) => r.skill_id);

  // Exits: every open row whose skill is no longer in the top N — including hard-ineligible skills,
  // which the board query excludes (§50.5 step 3).
  const { rows: exited } = await pool.query<{ skill_id: string }>(
    `update skill_hype_top set left_at = now()
      where left_at is null and not (skill_id = any($1::uuid[]))
      returning skill_id`,
    [incoming],
  );

  const { rows: openRows } = await pool.query<{ skill_id: string }>(`select skill_id from skill_hype_top where left_at is null`);
  const open = new Set(openRows.map((r) => r.skill_id));

  const entries: string[] = [];
  let notified = 0;
  for (const [i, row] of board.entries()) {
    if (open.has(row.skill_id)) continue;
    const client = await pool.connect();
    try {
      await client.query("begin");
      // Entry: (re)open the row; notified_at survives a re-entry so the 7-day dedup holds.
      const { rows: up } = await client.query<{ notified_at: Date | null }>(
        `insert into skill_hype_top (skill_id, entered_at, left_at) values ($1, now(), null)
         on conflict (skill_id) do update set entered_at = now(), left_at = null
         returning notified_at`,
        [row.skill_id],
      );
      const notifiedAt = up[0]?.notified_at ?? null;
      const { rows: sk } = await client.query<{ namespace_id: string; title: string }>(
        `select namespace_id, title from skills where id = $1`,
        [row.skill_id],
      );
      const nsId = sk[0]!.namespace_id;

      if (notifiedAt == null || Date.now() - new Date(notifiedAt).getTime() >= 7 * 24 * 60 * 60 * 1000) {
        const payload = {
          skillId: row.skill_id,
          namespaceSlug: row.namespace_slug,
          skillSlug: row.skill_slug,
          skillTitle: sk[0]!.title,
          rank: i + 1,
          score: row.score,
          hypeCount: row.hype_count,
          topN: settings.topN,
        };
        const ins = await client.query(
          `insert into notifications (user_id, type, payload)
           select u.id, 'skill.hyped', $3::jsonb
             from (${effectiveMaintainerIdsSql("$1", "$2")}) em
             join users u on u.id = em.user_id and u.status = 'active' and u.hype_notifications`,
          [row.skill_id, nsId, JSON.stringify(payload)],
        );
        notified += ins.rowCount ?? 0;
        await client.query(`update skill_hype_top set notified_at = now() where skill_id = $1`, [row.skill_id]);
      }

      // Awards (§50.9) — once ever per user per badge (the PK), no Habits evaluation: the person
      // did nothing at this hour, the sweep did.
      const { rows: maintainers } = await client.query<{ user_id: string }>(
        `select em.user_id from (${effectiveMaintainerIdsSql("$1", "$2")}) em
           join users u on u.id = em.user_id and u.status = 'active'`,
        [row.skill_id, nsId],
      );
      for (const m of maintainers) await awardAchievement(client, m.user_id, "hype_train", { noHabits: true });
      const { rows: hypers } = await client.query<{ user_id: string }>(
        `select distinct h.user_id from skill_hypes h join users u on u.id = h.user_id and u.status = 'active'
          where h.skill_id = $1 and h.created_at > now() - ${HYPE_WINDOW_SQL}`,
        [row.skill_id],
      );
      for (const h of hypers) await awardAchievement(client, h.user_id, "talent_scout", { noHabits: true });

      await client.query("commit");
      entries.push(row.skill_id);
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return { skipped: false, entries, exits: exited.map((r) => r.skill_id), notified };
}
