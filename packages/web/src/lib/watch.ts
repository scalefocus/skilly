// Watch / follow a skill. Watchers are notified when a new version is published (the worker
// publish sweep creates the notifications — see worker/git/publish.ts). SKILLY_SPEC.md §12.
import { pool } from "./db";

export async function isWatching(userId: string, skillId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`select 1 from skill_watches where user_id = $1 and skill_id = $2`, [userId, skillId]);
  return (rowCount ?? 0) > 0;
}

/** How many users are watching/following a skill (for the "N watching" label). */
export async function watcherCount(skillId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`select count(*)::text as n from skill_watches where skill_id = $1`, [skillId]);
  return Number(rows[0]?.n ?? 0);
}

export async function setWatch(userId: string, skillId: string, on: boolean): Promise<void> {
  if (on) {
    await pool.query(
      `insert into skill_watches (user_id, skill_id) values ($1, $2) on conflict do nothing`,
      [userId, skillId],
    );
  } else {
    await pool.query(`delete from skill_watches where user_id = $1 and skill_id = $2`, [userId, skillId]);
  }
}
