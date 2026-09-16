// RUM persistence + the platform-admin reads (SKILLY_SPEC.md §32.3, §32.7, §32.8). The web tier
// writes raw samples and the error index; the worker owns the daily rollup + pruning (worker/rum.ts).
//
// Range → source: 7d and 30d compute a TRUE p75 over `rum_samples`; 90d and All read `rum_daily`,
// where the vitals are the views-weighted mean of the daily p75 values (a percentile cannot be
// re-aggregated from percentiles) — the page says so in the column tooltip.
import type { Pool } from "pg";
import { pool } from "../db";
import { labelForRoute, RUM_ROUTE_ALL } from "./routes";
import { rumBucketFor } from "./math";
import type { RumSample } from "./validate";

export type RumRange = 7 | 30 | 90 | "all";
export const RUM_RANGES: readonly RumRange[] = [7, 30, 90, "all"];

export function parseRumRange(raw: string | null, fallback: RumRange = 7): RumRange {
  if (raw === "all") return "all";
  const n = Number(raw);
  return (RUM_RANGES as readonly (number | string)[]).includes(n) ? (n as RumRange) : fallback;
}

// ---- writes ---------------------------------------------------------------------------------------

/** Insert a validated batch for one user and upsert the error index. One round trip per table. */
export async function insertRumSamples(userId: string, samples: readonly RumSample[], db: Pool = pool): Promise<void> {
  if (samples.length === 0) return;
  await db.query(
    `insert into rum_samples (user_id, session_id, route, kind, name, value, ok)
     select $1::uuid, s.session_id, s.route, s.kind, s.name, s.value, s.ok
       from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::float8[], $7::boolean[])
         as s(session_id, route, kind, name, value, ok)`,
    [
      userId,
      samples.map((s) => s.sessionId),
      samples.map((s) => s.route),
      samples.map((s) => s.kind),
      samples.map((s) => s.name),
      samples.map((s) => s.value),
      samples.map((s) => s.ok),
    ],
  );

  // Error index: group this batch's occurrences per fingerprint, then upsert count/last_seen.
  const errs = new Map<string, { type: string; message: string; frame: string; count: number }>();
  for (const s of samples) {
    if (s.kind !== "error" || !s.name || !s.error) continue;
    const cur = errs.get(s.name);
    if (cur) cur.count += 1;
    else errs.set(s.name, { ...s.error, count: 1 });
  }
  if (errs.size === 0) return;
  const rows = [...errs.entries()];
  await db.query(
    `insert into rum_errors (fingerprint, type, message, frame, count, first_seen, last_seen)
     select e.fingerprint, e.type, e.message, e.frame, e.count, now(), now()
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[]) as e(fingerprint, type, message, frame, count)
     on conflict (fingerprint) do update
       set count = rum_errors.count + excluded.count, last_seen = now()`,
    [rows.map(([f]) => f), rows.map(([, e]) => e.type), rows.map(([, e]) => e.message), rows.map(([, e]) => e.frame), rows.map(([, e]) => e.count)],
  );
}

// ---- reads -----------------------------------------------------------------------------------------

export interface RumRouteRow {
  route: string;
  label: string;
  views: number;
  sessions: number;
  lcpP75: number | null;
  inpP75: number | null;
  clsP75: number | null;
  ttfbP75: number | null;
  navP75: number | null;
  apiP75: number | null;
  apiCalls: number;
  apiErrorRate: number | null;
  errors: number;
}

export interface RumSeriesPoint {
  date: string;
  views: number;
  lcpP75: number | null;
  inpP75: number | null;
}

export interface RumSummary {
  range: RumRange;
  bucket: "day" | "week" | "month";
  lastSampleAt: string | null;
  series: RumSeriesPoint[];
  routes: RumRouteRow[];
}

interface RouteAgg {
  route: string | null;
  views: string;
  sessions: string;
  lcp_p75: number | null;
  inp_p75: number | null;
  cls_p75: number | null;
  ttfb_p75: number | null;
  nav_p75: number | null;
  api_p75: number | null;
  api_calls: string;
  api_errors: string;
  errors: string;
}

const num = (v: number | string | null): number | null => (v == null ? null : Number(v));

function toRouteRow(r: RouteAgg): RumRouteRow {
  const route = r.route ?? RUM_ROUTE_ALL;
  const apiCalls = Number(r.api_calls);
  return {
    route,
    label: labelForRoute(route),
    views: Number(r.views),
    sessions: Number(r.sessions),
    lcpP75: num(r.lcp_p75),
    inpP75: num(r.inp_p75),
    clsP75: num(r.cls_p75),
    ttfbP75: num(r.ttfb_p75),
    navP75: num(r.nav_p75),
    apiP75: num(r.api_p75),
    apiCalls,
    apiErrorRate: apiCalls > 0 ? Number(r.api_errors) / apiCalls : null,
    errors: Number(r.errors),
  };
}

/** `all` first, then by views desc, then by route for a stable order. */
function orderRoutes(rows: RumRouteRow[]): RumRouteRow[] {
  return rows.sort((a, b) => {
    if (a.route === RUM_ROUTE_ALL) return -1;
    if (b.route === RUM_ROUTE_ALL) return 1;
    return b.views - a.views || a.route.localeCompare(b.route);
  });
}

// The p75 expression over raw samples, filtered to one kind (+ optional vital name).
const P75 = (where: string) => `percentile_cont(0.75) within group (order by value) filter (where ${where})`;

const RAW_AGG_COLUMNS = `
  count(*) filter (where kind = 'page_view')::text as views,
  count(distinct session_id)::text as sessions,
  ${P75("kind = 'vital' and name = 'lcp'")} as lcp_p75,
  ${P75("kind = 'vital' and name = 'inp'")} as inp_p75,
  ${P75("kind = 'vital' and name = 'cls'")} as cls_p75,
  ${P75("kind = 'vital' and name = 'ttfb'")} as ttfb_p75,
  ${P75("kind = 'nav'")} as nav_p75,
  ${P75("kind = 'api'")} as api_p75,
  count(*) filter (where kind = 'api')::text as api_calls,
  count(*) filter (where kind = 'api' and ok = false)::text as api_errors,
  count(*) filter (where kind = 'error')::text as errors`;

// The views-weighted mean of a rollup column across days.
const WMEAN = (col: string) => `sum(${col} * views) filter (where ${col} is not null) / nullif(sum(views) filter (where ${col} is not null), 0)`;

const ROLLUP_AGG_COLUMNS = `
  sum(views)::text as views,
  sum(sessions)::text as sessions,
  ${WMEAN("lcp_p75")} as lcp_p75,
  ${WMEAN("inp_p75")} as inp_p75,
  ${WMEAN("cls_p75")} as cls_p75,
  ${WMEAN("ttfb_p75")} as ttfb_p75,
  ${WMEAN("nav_p75")} as nav_p75,
  ${WMEAN("api_p75")} as api_p75,
  sum(api_calls)::text as api_calls,
  sum(api_errors)::text as api_errors,
  sum(errors)::text as errors`;

export async function getRumSummary(range: RumRange, db: Pool = pool): Promise<RumSummary> {
  const { rows: last } = await db.query<{ at: string | null }>(`select max(created_at)::text as at from rum_samples`);
  const lastSampleAt = last[0]?.at ? new Date(last[0].at).toISOString() : null;

  if (range === 7 || range === 30) {
    // Raw window: true p75s. `grouping sets` yields the per-route rows plus one total (route null → 'all').
    const [{ rows: agg }, { rows: series }] = await Promise.all([
      db.query<RouteAgg>(
        `select route, ${RAW_AGG_COLUMNS}
           from rum_samples
          where created_at > now() - make_interval(days => $1)
          group by grouping sets ((route), ())`,
        [range],
      ),
      db.query<{ day: string; views: string; lcp_p75: number | null; inp_p75: number | null }>(
        `select (created_at at time zone 'utc')::date::text as day,
                count(*) filter (where kind = 'page_view')::text as views,
                ${P75("kind = 'vital' and name = 'lcp'")} as lcp_p75,
                ${P75("kind = 'vital' and name = 'inp'")} as inp_p75
           from rum_samples
          where created_at > now() - make_interval(days => $1)
          group by 1 order by 1 asc`,
        [range],
      ),
    ]);
    const routes = orderRoutes(agg.map(toRouteRow));
    return {
      range,
      bucket: "day",
      lastSampleAt,
      series: series.map((r) => ({ date: r.day, views: Number(r.views), lcpP75: num(r.lcp_p75), inpP75: num(r.inp_p75) })),
      // An empty window still needs no 'all' row: grouping sets emits the total only when rows exist.
      routes,
    };
  }

  // Rollup window (90d / All). The span the rollup actually covers picks the bucket.
  const { rows: spanRows } = await db.query<{ span: number | null }>(`select (current_date - min(day) + 1)::int as span from rum_daily`);
  const bucket = rumBucketFor(range, spanRows[0]?.span ?? null);
  const where = range === "all" ? "" : `where day > current_date - make_interval(days => $1)`;
  const params = range === "all" ? [] : [range];
  const [{ rows: agg }, { rows: series }] = await Promise.all([
    db.query<RouteAgg>(`select route, ${ROLLUP_AGG_COLUMNS} from rum_daily ${where} group by route`, params),
    db.query<{ day: string; views: string; lcp_p75: number | null; inp_p75: number | null }>(
      // `bucket` is a trusted literal off rumBucketFor (never user input) — same pattern as lib/presence.ts.
      `select date_trunc('${bucket}', day)::date::text as day,
              sum(views)::text as views,
              ${WMEAN("lcp_p75")} as lcp_p75,
              ${WMEAN("inp_p75")} as inp_p75
         from rum_daily ${where ? `${where} and` : "where"} route = '${RUM_ROUTE_ALL}'
        group by 1 order by 1 asc`,
      params,
    ),
  ]);
  return {
    range,
    bucket,
    lastSampleAt,
    series: series.map((r) => ({ date: r.day, views: Number(r.views), lcpP75: num(r.lcp_p75), inpP75: num(r.inp_p75) })),
    routes: orderRoutes(agg.map(toRouteRow)),
  };
}

export interface RumRouteUser {
  userId: string;
  displayName: string;
  email: string;
  avatar: string | null;
  samples: number;
  lcpP75: number | null;
  inpP75: number | null;
  errors: number;
}

/** Top 20 people by sample count on a route (or every route for 'all') over a RAW window (7/30 only). */
export async function getRumRouteUsers(route: string, range: 7 | 30, db: Pool = pool): Promise<RumRouteUser[]> {
  const { rows } = await db.query<{ id: string; display_name: string; email: string; avatar: string | null; samples: string; lcp_p75: number | null; inp_p75: number | null; errors: string }>(
    `select u.id, u.display_name, u.email, u.avatar,
            count(*)::text as samples,
            ${P75("s.kind = 'vital' and s.name = 'lcp'")} as lcp_p75,
            ${P75("s.kind = 'vital' and s.name = 'inp'")} as inp_p75,
            count(*) filter (where s.kind = 'error')::text as errors
       from rum_samples s
       join users u on u.id = s.user_id
      where s.created_at > now() - make_interval(days => $1)
        and ($2::text = '${RUM_ROUTE_ALL}' or s.route = $2::text)
      group by u.id
      order by count(*) desc, u.display_name asc
      limit 20`,
    [range, route],
  );
  return rows.map((r) => ({
    userId: r.id,
    displayName: r.display_name,
    email: r.email,
    avatar: r.avatar,
    samples: Number(r.samples),
    lcpP75: num(r.lcp_p75),
    inpP75: num(r.inp_p75),
    errors: Number(r.errors),
  }));
}

export interface RumErrorRow {
  fingerprint: string;
  type: string;
  message: string;
  frame: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** Top 3 routes it occurred on in the last 30 days (from the raw samples). */
  routes: string[];
}

export async function listRumErrors(range: RumRange, offset: number, limit: number, db: Pool = pool): Promise<{ errors: RumErrorRow[]; total: number }> {
  const days = range === "all" ? null : range;
  const where = `where ($1::int is null or e.last_seen > now() - make_interval(days => $1))`;
  const [{ rows }, { rows: cnt }] = await Promise.all([
    db.query<{ fingerprint: string; type: string; message: string; frame: string; count: number; first_seen: string; last_seen: string; routes: string[] | null }>(
      `select e.fingerprint, e.type, e.message, e.frame, e.count, e.first_seen::text, e.last_seen::text,
              (select array_agg(r.route order by r.n desc)
                 from (select route, count(*) as n
                         from rum_samples
                        where kind = 'error' and name = e.fingerprint and created_at > now() - interval '30 days'
                        group by route order by n desc limit 3) r) as routes
         from rum_errors e
         ${where}
        order by e.last_seen desc, e.fingerprint asc
        offset $2 limit $3`,
      [days, offset, limit],
    ),
    db.query<{ n: string }>(`select count(*)::text as n from rum_errors e ${where}`, [days]),
  ]);
  return {
    errors: rows.map((r) => ({
      fingerprint: r.fingerprint,
      type: r.type,
      message: r.message,
      frame: r.frame,
      count: Number(r.count),
      firstSeen: new Date(r.first_seen).toISOString(),
      lastSeen: new Date(r.last_seen).toISOString(),
      routes: r.routes ?? [],
    })),
    total: Number(cnt[0]?.n ?? 0),
  };
}
