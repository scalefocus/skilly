// Daily active-user snapshot (worker, leader-only). Runs once a day: counts status='active'
// users with last_seen within the trailing 25 hours (a 1h buffer over 24h so a slightly-late
// run still catches a full day) and upserts one row into daily_active_users (migration 0047)
// keyed on today's UTC date — idempotent, so a re-run or restart the same day never
// double-writes. Feeds the trend chart on Administration. SKILLY_SPEC.md §4.
import type { Pool } from "pg";

export async function recordDailyActiveUsers(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `select count(*)::text as count from users where status = 'active' and last_seen > now() - interval '25 hours'`,
  );
  const count = Number(rows[0]?.count ?? 0);
  await pool.query(
    `insert into daily_active_users (day, count)
     values ((now() at time zone 'utc')::date, $1)
     on conflict (day) do update set count = excluded.count`,
    [count],
  );
  return count;
}
