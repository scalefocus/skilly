// System log (SKILLY_SPEC.md §25): record + read user-facing HTTP error events from the web
// tier. Operational telemetry, NOT governance audit — a plain mutable table (migration 0032),
// no hash chain. Platform-admin only (the /api/system-log route enforces it).
//
// Privacy (CLAUDE.md #6): we persist the matched route template + concrete path only — never
// the query string, body, headers, or a stack trace. 500 detail is a sanitized one-liner.
//
// This module imports ONLY the pg pool — deliberately no next-auth/guard — so it stays safe to
// import from instrumentation.ts (onRequestError). The route wrapper that needs the session lives
// separately in apiLog.ts.
import { pool } from "./db";

// ── What we record ──────────────────────────────────────────────────────────────────────────
// 5XX always; of the 4XX only the meaningful authz/validation/size/rate ones
// (403/409/413/422/429). A recorded 413 is app-origin (an upload over the configured
// max_bundle_bytes, §6) — a 413 from a reverse proxy in front of skilly never reaches the app
// and so can never appear here. 401 is excluded entirely (constant noise from expired/anonymous
// polling of the bell, messages, /api/me) and /api/* 404s are polling noise too — both fall
// through the final return as false.
export function shouldRecord(status: number, _path: string): boolean {
  if (status >= 500) return true;
  return status === 403 || status === 409 || status === 413 || status === 422 || status === 429;
}

export function sanitizeMessage(input: unknown, max = 300): string {
  const s = input instanceof Error ? input.message : String(input ?? "");
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

export interface RecordInput {
  status: number;
  method: string;
  route: string;
  path: string;
  userId: string | null;
  errorCode: string | null;
  message: string | null;
  requestId: string | null;
  durationMs: number | null;
  source?: "web" | "worker";
}

/**
 * Insert one system event. Callers fire-and-forget this (`void record().catch(()=>{})`).
 * Actor name/email are denormalized from users via a correlated subquery (no extra round-trip)
 * so the search blob stays fully local and the trigram index applies.
 */
export async function recordSystemEvent(e: RecordInput): Promise<void> {
  await pool.query(
    `insert into system_event
       (status, method, route, path, user_id, actor_name, actor_email, error_code, message, request_id, duration_ms, source)
     values ($1,$2,$3,$4,$5,
             (select display_name from users where id = $5),
             (select email from users where id = $5),
             $6,$7,$8,$9,$10)`,
    [
      e.status,
      e.method,
      e.route.slice(0, 300),
      e.path.slice(0, 500),
      e.userId,
      e.errorCode?.slice(0, 200) ?? null,
      e.message ? sanitizeMessage(e.message) : null,
      e.requestId?.slice(0, 200) ?? null,
      e.durationMs,
      e.source ?? "web",
    ],
  );
}

// ── Reading (the /system-log screen) ─────────────────────────────────────────────────────────
export interface SystemEventView {
  id: string;
  createdAt: string;
  status: number;
  method: string;
  route: string;
  path: string;
  userId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  errorCode: string | null;
  message: string | null;
  requestId: string | null;
  durationMs: number | null;
  source: string;
}

export interface SystemEventQuery {
  /** free-text substring across path/error_code/message/user_id + actor email/name */
  q?: string;
  /** status chip: "5xx" | "403" | "409" | "413" | "422" | "429" | "" (all) */
  status?: string;
  /** inclusive date range on created_at (ISO instants); each end optional */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** Shared WHERE-clause builder for listSystemEvents / countSystemEvents / exportSystemEventRows,
 *  so all three stay in lockstep on exactly what a filter means. */
function systemEventFilter(q: SystemEventQuery): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (q.status === "5xx") {
    where.push("s.status >= 500");
  } else if (q.status && /^\d{3}$/.test(q.status)) {
    params.push(Number(q.status));
    where.push(`s.status = $${params.length}`);
  }

  const term = q.q?.trim();
  if (term) {
    params.push(`%${term}%`);
    const i = params.length;
    // Single ILIKE over the SAME blob expression the trigram GIN index is built on (migration
    // 0032) — kept byte-identical so the planner uses the index. Actor name/email are part of
    // the blob (denormalized on the row), so there is no cross-table OR to defeat it.
    where.push(
      `(coalesce(s.path,'') || ' ' || coalesce(s.error_code,'') || ' ' || coalesce(s.message,'') || ' ' ||` +
        ` coalesce(s.user_id::text,'') || ' ' || coalesce(s.actor_email,'') || ' ' || coalesce(s.actor_name,'')) ilike $${i}`,
    );
  }

  // Inclusive date range on created_at (each end optional; ISO instants from the From/To pickers).
  if (q.from) {
    params.push(q.from);
    where.push(`s.created_at >= $${params.length}`);
  }
  if (q.to) {
    params.push(q.to);
    where.push(`s.created_at <= $${params.length}`);
  }
  return { where, params };
}

async function queryEventRows(where: string[], params: unknown[], limit: number, offset: number): Promise<SystemEventView[]> {
  const p = [...params, limit, offset];
  const limitIdx = p.length - 1;
  const offsetIdx = p.length;
  const { rows } = await pool.query<{
    id: string;
    created_at: string;
    status: number;
    method: string;
    route: string;
    path: string;
    user_id: string | null;
    actor_name: string | null;
    actor_email: string | null;
    error_code: string | null;
    message: string | null;
    request_id: string | null;
    duration_ms: number | null;
    source: string;
  }>(
    `select s.id, s.created_at, s.status, s.method, s.route, s.path, s.user_id,
            s.actor_name, s.actor_email,
            s.error_code, s.message, s.request_id, s.duration_ms, s.source
       from system_event s
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by s.created_at desc
      limit $${limitIdx} offset $${offsetIdx}`,
    p,
  );

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    status: r.status,
    method: r.method,
    route: r.route,
    path: r.path,
    userId: r.user_id,
    actorName: r.actor_name,
    actorEmail: r.actor_email,
    errorCode: r.error_code,
    message: r.message,
    requestId: r.request_id,
    durationMs: r.duration_ms,
    source: r.source,
  }));
}

export async function listSystemEvents(q: SystemEventQuery = {}): Promise<SystemEventView[]> {
  const { where, params } = systemEventFilter(q);
  return queryEventRows(where, params, Math.min(500, q.limit ?? 100), Math.max(0, q.offset ?? 0));
}

/** Hard cap on a CSV export (see exportSystemEventRows) — bounds a single query/response
 *  regardless of how wide the admin's filter is. SKILLY_SPEC.md §25. */
export const SYSTEM_EVENT_EXPORT_CAP = 50_000;

/** Total rows matching the SAME filter as listSystemEvents/exportSystemEventRows — lets the
 *  export route tell the caller whether the capped download is complete or was truncated. */
export async function countSystemEvents(q: SystemEventQuery = {}): Promise<number> {
  const { where, params } = systemEventFilter(q);
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from system_event s ${where.length ? `where ${where.join(" and ")}` : ""}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Rows for CSV export: the SAME filter as listSystemEvents, newest-first, capped at
 *  SYSTEM_EVENT_EXPORT_CAP (no pagination offset). SKILLY_SPEC.md §25. */
export async function exportSystemEventRows(q: SystemEventQuery = {}): Promise<SystemEventView[]> {
  const { where, params } = systemEventFilter(q);
  return queryEventRows(where, params, SYSTEM_EVENT_EXPORT_CAP, 0);
}
