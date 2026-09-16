// Real user monitoring — the worker's two leader-only jobs (SKILLY_SPEC.md §32.3).
//
//   rollupRum  Recomputes and UPSERTS `rum_daily` for today and yesterday (UTC) from the raw
//              samples, once at boot then hourly. Because raw samples live 30 days, a missed run
//              self-heals on the next one — unlike the DAU snapshot (dau.ts), which has no source
//              to reconstruct from. Writes one row per route PLUS an explicit 'all' row whose
//              percentiles are the true p75 over every sample that day, so the platform-wide
//              numbers for the 90d/All ranges are exact rather than a mean of per-route p75s.
//   pruneRum   Housekeeping: raw samples older than 30 days and error fingerprints idle for more
//              than 90 days (the System log's retention). `rum_daily` is never pruned.
import type { Pool } from "pg";

const P75 = (where: string) => `percentile_cont(0.75) within group (order by value) filter (where ${where})`;

const AGG = `
  count(*) filter (where kind = 'page_view')::int as views,
  count(distinct session_id)::int as sessions,
  ${P75("kind = 'vital' and name = 'lcp'")} as lcp_p75,
  ${P75("kind = 'vital' and name = 'inp'")} as inp_p75,
  ${P75("kind = 'vital' and name = 'cls'")} as cls_p75,
  ${P75("kind = 'vital' and name = 'ttfb'")} as ttfb_p75,
  ${P75("kind = 'nav'")} as nav_p75,
  ${P75("kind = 'api'")} as api_p75,
  count(*) filter (where kind = 'api')::int as api_calls,
  count(*) filter (where kind = 'api' and ok = false)::int as api_errors,
  count(*) filter (where kind = 'error')::int as errors`;

/** Roll one UTC day up into rum_daily. Returns the number of (day, route) rows upserted. */
export async function rollupRumDay(pool: Pool, day: string): Promise<number> {
  const { rowCount } = await pool.query(
    `with s as (
       select * from rum_samples
        where created_at >= ($1::date::timestamp at time zone 'utc')
          and created_at <  (($1::date + 1)::timestamp at time zone 'utc')
     )
     insert into rum_daily (day, route, views, sessions, lcp_p75, inp_p75, cls_p75, ttfb_p75, nav_p75, api_p75, api_calls, api_errors, errors)
     select $1::date, coalesce(route, 'all'), ${AGG}
       from s
      group by grouping sets ((route), ())
     on conflict (day, route) do update set
       views = excluded.views, sessions = excluded.sessions,
       lcp_p75 = excluded.lcp_p75, inp_p75 = excluded.inp_p75, cls_p75 = excluded.cls_p75, ttfb_p75 = excluded.ttfb_p75,
       nav_p75 = excluded.nav_p75, api_p75 = excluded.api_p75,
       api_calls = excluded.api_calls, api_errors = excluded.api_errors, errors = excluded.errors`,
    [day],
  );
  return rowCount ?? 0;
}

/** Today's and yesterday's UTC dates as YYYY-MM-DD. */
export function rollupDays(now: Date = new Date()): [string, string] {
  const today = now.toISOString().slice(0, 10);
  const y = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  return [today, y];
}

/** The hourly sweep: today + yesterday, so a run just after midnight still completes the prior day. */
export async function rollupRum(pool: Pool, now: Date = new Date()): Promise<number> {
  let n = 0;
  for (const day of rollupDays(now)) n += await rollupRumDay(pool, day);
  return n;
}

export const RUM_RAW_RETENTION = "30 days";
export const RUM_ERROR_IDLE_RETENTION = "90 days";

export async function pruneRum(pool: Pool): Promise<{ samples: number; errors: number }> {
  const a = await pool.query(`delete from rum_samples where created_at < now() - $1::interval`, [RUM_RAW_RETENTION]);
  const b = await pool.query(`delete from rum_errors where last_seen < now() - $1::interval`, [RUM_ERROR_IDLE_RETENTION]);
  return { samples: a.rowCount ?? 0, errors: b.rowCount ?? 0 };
}
