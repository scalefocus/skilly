// Usage analytics (SKILLY_SPEC.md §21). Views come from usage_events (logged fire-and-forget
// by the skill-detail route); installs come from access_log (the git clone). Entitlement is
// "can you govern/own the skill" (reuses §19): platform admin → all + platform aggregate,
// namespace admin → their namespaces + namespace aggregate, maintainer → only their skills.
import { pool } from "./db";
import type { EffectiveAccess } from "@skilly/shared";

export interface MetricWindows {
  d1: number; d1Prev: number; d7: number; d7Prev: number; d30: number; d30Prev: number; all: number;
}
/** Daily series aligned to UsageDashboard.seriesDays (oldest → newest). §21 "Graphs". */
export interface DailySeries { views: number[]; installs: number[] }
export interface SkillUsage { namespaceSlug: string; skillSlug: string; title: string; toolHarness: string; views: MetricWindows; installs: MetricWindows; daily: DailySeries }
export interface UsageAggregate { scope: "platform" | "namespace"; views: MetricWindows; installs: MetricWindows; series: DailySeries }
export interface UsageDashboard {
  aggregate: UsageAggregate | null;
  skills: SkillUsage[];
  /** ISO dates (DB-clock days, oldest → newest) for all daily buckets — one shared time axis. */
  seriesDays: string[];
}

/** Chartable ranges (§21): daily buckets over 7/30/90 days; default 30. Plus "all" — the dashboard
 *  chart can span all time, stepping the bucket up (day→week→month) so the point count stays
 *  bounded (same approach as the per-skill detail chart). */
export const SERIES_DAYS_CHOICES = [7, 30, 90] as const;
export type SeriesDays = (typeof SERIES_DAYS_CHOICES)[number];
export type SeriesRangeOpt = SeriesDays | "all";

interface WRow { d1: number; d1_prev: number; d7: number; d7_prev: number; d30: number; d30_prev: number; total: number }

// Conditional-aggregation columns for the four windows + their prior windows (for deltas).
// `col` is a trusted column name (never user input).
function windowCols(col: string): string {
  return `
    count(*) filter (where ${col} >= now() - interval '1 day')::int as d1,
    count(*) filter (where ${col} >= now() - interval '2 days' and ${col} < now() - interval '1 day')::int as d1_prev,
    count(*) filter (where ${col} >= now() - interval '7 days')::int as d7,
    count(*) filter (where ${col} >= now() - interval '14 days' and ${col} < now() - interval '7 days')::int as d7_prev,
    count(*) filter (where ${col} >= now() - interval '30 days')::int as d30,
    count(*) filter (where ${col} >= now() - interval '60 days' and ${col} < now() - interval '30 days')::int as d30_prev,
    count(*)::int as total`;
}
const ZERO: MetricWindows = { d1: 0, d1Prev: 0, d7: 0, d7Prev: 0, d30: 0, d30Prev: 0, all: 0 };
function toWindows(r: WRow | undefined): MetricWindows {
  if (!r) return { ...ZERO };
  return { d1: r.d1, d1Prev: r.d1_prev, d7: r.d7, d7Prev: r.d7_prev, d30: r.d30, d30Prev: r.d30_prev, all: r.total };
}

/** Fire-and-forget view event (called from the skill-detail route AFTER the visibility check). */
export function logView(skillId: string, namespaceId: string, userId: string): void {
  void pool
    .query(`insert into usage_events (skill_id, namespace_id, actor_user_id) values ($1, $2, $3)`, [skillId, namespaceId, userId])
    .catch(() => {}); // analytics is best-effort; never surface to the request
}

function adminNamespaces(access: EffectiveAccess): string[] {
  return [...access.namespaceRoles.entries()].filter(([, role]) => role === "namespace_admin").map(([ns]) => ns);
}

/** The day axis, computed on the DB clock (avoids app/DB timezone drift). Oldest → newest. */
async function seriesDayAxis(days: number): Promise<string[]> {
  const { rows } = await pool.query<{ day: string }>(
    `select generate_series(current_date - ($1::int - 1), current_date, interval '1 day')::date::text as day`,
    [days],
  );
  return rows.map((r) => r.day);
}

/** Zero-filled per-key daily counts from (key, day, n) rows, aligned to the axis. */
function bucketize(axis: string[], rows: { key: string; day: string; n: number }[]): Map<string, number[]> {
  const idx = new Map(axis.map((d, i) => [d, i]));
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const i = idx.get(r.day);
    if (i == null) continue;
    let arr = out.get(r.key);
    if (!arr) out.set(r.key, (arr = new Array(axis.length).fill(0)));
    arr[i] = r.n;
  }
  return out;
}
const zeros = (n: number) => new Array<number>(n).fill(0);

// Bucket-step literals for adaptive ("all") axes. Trusted — never user input.
const SERIES_BUCKET_INTERVAL: Record<"day" | "week" | "month", string> = { day: "1 day", week: "1 week", month: "1 month" };

/** Earliest view/install instant in the caller's scope (for the "all-time" axis start), or null. */
async function earliestEventInScope(isPlatformAdmin: boolean, ids: string[]): Promise<string | null> {
  if (isPlatformAdmin) {
    const { rows } = await pool.query<{ m: string | null }>(
      `select least((select min(created_at) from usage_events),
                    (select min(created_at) from access_log where source = 'git'))::text as m`,
    );
    return rows[0]?.m ?? null;
  }
  if (!ids.length) return null;
  const { rows } = await pool.query<{ m: string | null }>(
    `select least((select min(created_at) from usage_events where skill_id = any($1::uuid[])),
                  (select min(created_at) from access_log where source = 'git' and skill_id = any($1::uuid[])))::text as m`,
    [ids],
  );
  return rows[0]?.m ?? null;
}

/**
 * The shared dashboard chart axis + bucket granularity. Fixed ranges bucket by day; "all" spans
 * from the earliest event in scope and steps the bucket up (day ≤ ~3mo, week ≤ ~2y, else month).
 * `bucket` is a trusted literal; `axisStart` is the first bucket's date (the series lower bound).
 */
async function resolveSeriesAxis(range: SeriesRangeOpt, isPlatformAdmin: boolean, ids: string[]): Promise<{ bucket: "day" | "week" | "month"; axisStart: string; axis: string[] }> {
  if (range !== "all") {
    const axis = await seriesDayAxis(range);
    return { bucket: "day", axisStart: axis[0] ?? "", axis };
  }
  const earliest = await earliestEventInScope(isPlatformAdmin, ids);
  if (!earliest) {
    const axis = await seriesDayAxis(30); // no data yet → a tidy 30-day daily axis
    return { bucket: "day", axisStart: axis[0] ?? "", axis };
  }
  const spanDays = Math.max(1, Math.ceil((Date.now() - new Date(earliest).getTime()) / 86_400_000));
  const bucket: "day" | "week" | "month" = spanDays <= 92 ? "day" : spanDays <= 730 ? "week" : "month";
  const { rows } = await pool.query<{ day: string }>(
    `select generate_series(date_trunc('${bucket}', $1::timestamptz)::date, date_trunc('${bucket}', current_date)::date, interval '${SERIES_BUCKET_INTERVAL[bucket]}')::date::text as day`,
    [earliest],
  );
  const axis = rows.map((r) => r.day);
  return { bucket, axisStart: axis[0] ?? "", axis };
}

/**
 * The usage dashboard for a caller: entitled skills (with windows + daily series for
 * sparklines) + the aggregate they may see (with its own daily series for the chart).
 * `range` picks the charted span (7/30/90/all, §21) — the number-strip windows are unaffected.
 */
export async function getUsageDashboard(access: EffectiveAccess, userId: string, range: SeriesRangeOpt = 30, q?: string): Promise<UsageDashboard> {
  const adminNs = adminNamespaces(access);
  // Text filter over the entitled list, applied server-side so search spans the whole list (not
  // just the page the client has scrolled into view). LIKE wildcards in user input are escaped —
  // a literal "%"/"_" matches itself.
  const like = q?.trim() ? `%${q.trim().replace(/([%_\\])/g, "\\$1")}%` : null;

  // 1. Entitled skills (active only). Platform admin → all; else admin-namespaces ∪ maintained.
  const entitled = access.isPlatformAdmin
    ? (await pool.query<{ id: string; ns_slug: string; skill_slug: string; title: string; tool_harness: string }>(
        `select s.id, n.slug as ns_slug, s.slug as skill_slug, s.title, s.tool_harness
           from skills s join namespaces n on n.id = s.namespace_id
          where s.status = 'active'
            ${like ? `and (s.title ilike $1 or s.slug ilike $1 or n.slug ilike $1)` : ""}`,
        like ? [like] : [],
      )).rows
    : (await pool.query<{ id: string; ns_slug: string; skill_slug: string; title: string; tool_harness: string }>(
        `select s.id, n.slug as ns_slug, s.slug as skill_slug, s.title, s.tool_harness
           from skills s join namespaces n on n.id = s.namespace_id
          where s.status = 'active'
            and (s.namespace_id = any($1::uuid[])
                 or exists (select 1 from skill_maintainers sm where sm.skill_id = s.id and sm.user_id = $2))
            ${like ? `and (s.title ilike $3 or s.slug ilike $3 or n.slug ilike $3)` : ""}`,
        like ? [adminNs, userId, like] : [adminNs, userId],
      )).rows;

  // 2. Windowed views + installs for those skills, plus per-day buckets for sparklines.
  const ids = entitled.map((s) => s.id);
  // Shared chart axis (aggregate chart + per-skill sparklines): fixed ranges → daily; "all" →
  // adaptive buckets from the earliest event. `bucket` is a trusted literal; `axisStart` (a date)
  // is the series lower bound, supplied as a param.
  const { bucket, axisStart, axis } = await resolveSeriesAxis(range, access.isPlatformAdmin, ids);
  const trunc = (col: string) => `date_trunc('${bucket}', ${col})`;
  const since = (col: string, p: number) => `${col} >= $${p}::date`;
  const skills: SkillUsage[] = [];
  if (ids.length) {
    const [views, installs, vDaily, iDaily] = await Promise.all([
      pool.query<WRow & { skill_id: string }>(`select skill_id, ${windowCols("created_at")} from usage_events where skill_id = any($1::uuid[]) group by skill_id`, [ids]),
      pool.query<WRow & { skill_id: string }>(`select skill_id, ${windowCols("created_at")} from access_log where source = 'git' and skill_id = any($1::uuid[]) group by skill_id`, [ids]),
      pool.query<{ key: string; day: string; n: number }>(
        `select skill_id as key, ${trunc("created_at")}::date::text as day, count(*)::int as n
           from usage_events where skill_id = any($1::uuid[]) and ${since("created_at", 2)} group by skill_id, day`,
        [ids, axisStart],
      ),
      pool.query<{ key: string; day: string; n: number }>(
        `select skill_id as key, ${trunc("created_at")}::date::text as day, count(*)::int as n
           from access_log where source = 'git' and skill_id = any($1::uuid[]) and ${since("created_at", 2)} group by skill_id, day`,
        [ids, axisStart],
      ),
    ]);
    const vmap = new Map(views.rows.map((r) => [r.skill_id, r]));
    const imap = new Map(installs.rows.map((r) => [r.skill_id, r]));
    const vSeries = bucketize(axis, vDaily.rows);
    const iSeries = bucketize(axis, iDaily.rows);
    for (const s of entitled) {
      skills.push({
        namespaceSlug: s.ns_slug,
        skillSlug: s.skill_slug,
        title: s.title,
        toolHarness: s.tool_harness,
        views: toWindows(vmap.get(s.id)),
        installs: toWindows(imap.get(s.id)),
        daily: { views: vSeries.get(s.id) ?? zeros(axis.length), installs: iSeries.get(s.id) ?? zeros(axis.length) },
      });
    }
    // Default sort: 30d installs desc, then 30d views, then title. The full list is returned; the
    // client paginates it (renders 100 at a time, growing on scroll), so nothing is dropped here.
    skills.sort((a, b) => b.installs.d30 - a.installs.d30 || b.views.d30 - a.views.d30 || a.title.localeCompare(b.title));
  }

  // 3. Aggregate: platform-wide (global admin) or per-namespace (namespace admin). Maintainers:
  // none. The aggregate carries its own daily series for the §21 chart, same scoping.
  const flat = (m: Map<string, number[]>) => m.get("x") ?? zeros(axis.length);
  let aggregate: UsageAggregate | null = null;
  if (access.isPlatformAdmin) {
    const [v, i, vs, is] = await Promise.all([
      pool.query<WRow>(`select ${windowCols("created_at")} from usage_events`),
      pool.query<WRow>(`select ${windowCols("created_at")} from access_log where source = 'git'`),
      pool.query<{ key: string; day: string; n: number }>(
        `select 'x' as key, ${trunc("created_at")}::date::text as day, count(*)::int as n
           from usage_events where ${since("created_at", 1)} group by day`,
        [axisStart],
      ),
      pool.query<{ key: string; day: string; n: number }>(
        `select 'x' as key, ${trunc("created_at")}::date::text as day, count(*)::int as n
           from access_log where source = 'git' and ${since("created_at", 1)} group by day`,
        [axisStart],
      ),
    ]);
    aggregate = {
      scope: "platform",
      views: toWindows(v.rows[0]),
      installs: toWindows(i.rows[0]),
      series: { views: flat(bucketize(axis, vs.rows)), installs: flat(bucketize(axis, is.rows)) },
    };
  } else if (adminNs.length) {
    const [v, i, vs, is] = await Promise.all([
      pool.query<WRow>(`select ${windowCols("created_at")} from usage_events where namespace_id = any($1::uuid[])`, [adminNs]),
      pool.query<WRow>(`select ${windowCols("al.created_at")} from access_log al join skills s on s.id = al.skill_id where al.source = 'git' and s.namespace_id = any($1::uuid[])`, [adminNs]),
      pool.query<{ key: string; day: string; n: number }>(
        `select 'x' as key, ${trunc("created_at")}::date::text as day, count(*)::int as n
           from usage_events where namespace_id = any($1::uuid[]) and ${since("created_at", 2)} group by day`,
        [adminNs, axisStart],
      ),
      pool.query<{ key: string; day: string; n: number }>(
        `select 'x' as key, ${trunc("al.created_at")}::date::text as day, count(*)::int as n
           from access_log al join skills s on s.id = al.skill_id
          where al.source = 'git' and s.namespace_id = any($1::uuid[]) and ${since("al.created_at", 2)} group by day`,
        [adminNs, axisStart],
      ),
    ]);
    aggregate = {
      scope: "namespace",
      views: toWindows(v.rows[0]),
      installs: toWindows(i.rows[0]),
      series: { views: flat(bucketize(axis, vs.rows)), installs: flat(bucketize(axis, is.rows)) },
    };
  }

  return { aggregate, skills, seriesDays: axis };
}

// Per-skill trend chart on the detail page (§21). The toggle offers 7d / 30d / 90d / all-time.
// Fixed ranges bucket by day; "all" spans from the skill's creation and steps the bucket up
// (day → week → month) as the span grows, so the point count stays bounded and readable.
export type SeriesRange = "7d" | "30d" | "90d" | "all";
export const SERIES_RANGES: readonly SeriesRange[] = ["7d", "30d", "90d", "all"] as const;
const BUCKET_INTERVAL: Record<"day" | "week" | "month", string> = { day: "1 day", week: "1 week", month: "1 month" };

export interface SkillSeriesPoint { date: string; views: number; installs: number }
export interface SkillSeries { range: SeriesRange; bucket: "day" | "week" | "month"; points: SkillSeriesPoint[] }

/**
 * Daily/weekly/monthly views + installs for ONE skill over the chosen range. Caller entitlement
 * is checked by the route (owner-only, same as the breakdown). `bucket` is a trusted literal
 * derived from the validated range/span — never user input — so it's safe to interpolate.
 */
export async function getSkillSeries(skillId: string, createdAtIso: string, range: SeriesRange): Promise<SkillSeries> {
  let bucket: "day" | "week" | "month" = "day";
  // The axis query and the data queries carry DIFFERENT parameter sets (the axis never references
  // skillId), so each gets its own SQL + params — sharing one array mismatches the placeholders.
  let axisSql: string;
  let axisParams: unknown[];
  let sinceExpr: string; // lower-bound expression for the data queries
  const dataParams: unknown[] = [skillId]; // $1 = skillId in both data queries
  if (range === "all") {
    const spanDays = Math.max(1, Math.ceil((Date.now() - new Date(createdAtIso).getTime()) / 86_400_000));
    bucket = spanDays <= 92 ? "day" : spanDays <= 730 ? "week" : "month";
    const step = BUCKET_INTERVAL[bucket];
    axisSql = `select generate_series(date_trunc('${bucket}', $1::timestamptz)::date, date_trunc('${bucket}', now())::date, interval '${step}')::date::text as day`;
    axisParams = [createdAtIso];
    dataParams.push(createdAtIso); // $2
    sinceExpr = `date_trunc('${bucket}', $2::timestamptz)`;
  } else {
    const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
    const startExpr = `(date_trunc('day', now()) - interval '${days - 1} days')`;
    axisSql = `select generate_series(${startExpr}::date, date_trunc('day', now())::date, interval '1 day')::date::text as day`;
    axisParams = []; // no placeholders — the range is baked in as a trusted literal
    sinceExpr = startExpr;
  }

  // One bucket per axis slot, from the first bucket through the current one (inclusive).
  const axisRows = await pool.query<{ day: string }>(axisSql, axisParams);
  const axis = axisRows.rows.map((r) => r.day);

  const [views, installs] = await Promise.all([
    pool.query<{ day: string; n: number }>(
      `select date_trunc('${bucket}', created_at)::date::text as day, count(*)::int as n
         from usage_events where skill_id = $1 and created_at >= ${sinceExpr} group by day`,
      dataParams,
    ),
    pool.query<{ day: string; n: number }>(
      `select date_trunc('${bucket}', created_at)::date::text as day, count(*)::int as n
         from access_log where source = 'git' and skill_id = $1 and created_at >= ${sinceExpr} group by day`,
      dataParams,
    ),
  ]);
  const vIdx = new Map(views.rows.map((r) => [r.day, r.n]));
  const iIdx = new Map(installs.rows.map((r) => [r.day, r.n]));
  const points = axis.map((d) => ({ date: d, views: vIdx.get(d) ?? 0, installs: iIdx.get(d) ?? 0 }));
  return { range, bucket, points };
}

export interface UsageBreakdown {
  viewers: { displayName: string; email: string; count: number }[];
  installers: { displayName: string; email: string; count: number }[];
  anonymousInstalls: number;
  /** Clones via SYSTEM installations (§23) — no actor; shown as a separate bucket. */
  systemInstalls: number;
  /** Views+installs over the SAME range as the lists, so the chart above them matches the filter. */
  series: SkillSeries;
}

const RANGE_INTERVAL: Record<Exclude<SeriesRange, "all">, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days" };

/** Top viewers/installers for one skill in a range (7d/30d/90d/all) + the matching chart series, so
 *  the expanded chart and the people lists below it always show the same period. Entitlement is
 *  checked by the route. */
export async function getBreakdown(skillId: string, createdAtIso: string, range: SeriesRange): Promise<UsageBreakdown> {
  const interval = range === "all" ? null : RANGE_INTERVAL[range];
  const within = (col: string) => (interval ? `and ${col} >= now() - interval '${interval}'` : "");

  const [viewers, installers, anon, system, series] = await Promise.all([
    pool.query<{ display_name: string; email: string; n: number }>(
      `select u.display_name, u.email, count(*)::int as n
         from usage_events e join users u on u.id = e.actor_user_id
        where e.skill_id = $1 ${within("e.created_at")}
        group by u.id, u.display_name, u.email order by n desc limit 20`,
      [skillId],
    ),
    pool.query<{ display_name: string; email: string; n: number }>(
      `select u.display_name, u.email, count(*)::int as n
         from access_log al join users u on u.id = al.actor_user_id
        where al.skill_id = $1 and al.source = 'git' ${within("al.created_at")}
        group by u.id, u.display_name, u.email order by n desc limit 20`,
      [skillId],
    ),
    // Legacy anonymous/tokenless clones — no actor and NOT a system installation.
    pool.query<{ n: number }>(
      `select count(*)::int as n from access_log
        where skill_id = $1 and source = 'git' and actor_user_id is null and not is_system ${within("created_at")}`,
      [skillId],
    ),
    // System-installation clones (§23) — actorless by design, bucketed separately.
    pool.query<{ n: number }>(
      `select count(*)::int as n from access_log
        where skill_id = $1 and source = 'git' and is_system ${within("created_at")}`,
      [skillId],
    ),
    getSkillSeries(skillId, createdAtIso, range),
  ]);

  return {
    viewers: viewers.rows.map((r) => ({ displayName: r.display_name, email: r.email, count: r.n })),
    installers: installers.rows.map((r) => ({ displayName: r.display_name, email: r.email, count: r.n })),
    anonymousInstalls: anon.rows[0]?.n ?? 0,
    systemInstalls: system.rows[0]?.n ?? 0,
    series,
  };
}
