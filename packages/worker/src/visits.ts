// Visit-day retention (worker, leader-only; SKILLY_SPEC.md §67.5). `user_visit_days` keeps one row
// per user per active UTC day for the hover card's Visits row, which only ever looks at the trailing
// 28 days — so anything older is deleted once a day. Runs whatever `visits_enabled` says: the switch
// only hides the rows, and this prune is what bounds what is kept.
import type { Pool } from "pg";

/** Days kept, today included — the Visits window (`VISIT_WINDOW_DAYS` in @skilly/shared/visits). */
export const VISIT_DAYS_KEPT = 28;

/** Delete visit days older than the 28-day window. Returns how many rows went. */
export async function pruneVisitDays(pool: Pool): Promise<number> {
  const r = await pool.query(
    `delete from user_visit_days where day < (now() at time zone 'utc')::date - $1::int`,
    [VISIT_DAYS_KEPT - 1],
  );
  return r.rowCount ?? 0;
}
