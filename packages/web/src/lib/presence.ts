// User presence — "currently online" (SKILLY_SPEC.md §4). Activity-window based: there is no
// server-side session store (stateless JWTs), so presence is derived from a `users.last_seen`
// timestamp stamped on authenticated activity. A user is "online" if last_seen is within the
// viewing admin's selected window (a fixed option set, default ONLINE_WINDOW_MINUTES).
import { pool } from "./db";
import { userLabel } from "./userLabel";

/** Default "online" window in minutes (SKILLY_SPEC.md §4). */
export const ONLINE_WINDOW_MINUTES = 5;
/** The only windows an admin may select (§4) — the API rejects anything else back to the default. */
export const ONLINE_WINDOW_OPTIONS = [5, 60, 480, 1440, 43200] as const;

/** How often (ms) a single user's last_seen is written, regardless of request volume. */
const STAMP_THROTTLE_MS = 60_000;

/** Cap on a beacon-supplied page label (§4) — generous for any resolved route label, small
 * enough to keep the online-list row from being pushed around by a pathological value. */
export const MAX_PAGE_LABEL_LEN = 120;

/**
 * Validate/trim a client-supplied page label for the `/api/presence/page` beacon (§4). A
 * non-string, empty, or whitespace-only value resolves to `null` — the caller then skips the
 * write entirely rather than erroring (the beacon must never surface as a UI error).
 */
export function sanitizePageLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, MAX_PAGE_LABEL_LEN) : null;
}

// Per-process throttle: skip the write if we stamped this user within STAMP_THROTTLE_MS. Each web
// replica throttles independently (worst case a few redundant writes); presence needn't be exact.
const lastStampMs = new Map<string, number>();

/**
 * Record that `userId` is active right now — fire-and-forget and throttled. NEVER throws and never
 * blocks the caller: presence is best-effort and must not affect request handling. Called from the
 * `currentAccess()` choke point on every authenticated request, and (with a `page` label) from the
 * `/api/presence/page` beacon (§4) — both share the SAME per-user throttle, so a beacon landing
 * inside another call's throttle window is dropped just like an extra plain stamp, and a plain
 * stamp (no `page`) never clears a previously-recorded `last_seen_page`.
 */
export function touchLastSeen(userId: string, page?: string): void {
  const now = Date.now();
  const prev = lastStampMs.get(userId);
  if (prev && now - prev < STAMP_THROTTLE_MS) return;
  lastStampMs.set(userId, now); // set BEFORE the async write so concurrent calls don't stampede
  const query = page
    ? pool.query(`update users set last_seen = now(), last_seen_page = $2 where id = $1`, [userId, page])
    : pool.query(`update users set last_seen = now() where id = $1`, [userId]);
  void query.catch(() => {
    // best-effort: drop the throttle stamp so a later request retries the write
    lastStampMs.delete(userId);
  });
}

export interface OnlineUser {
  userId: string;
  displayName: string;
  email: string;
  avatar: string | null;
  lastSeen: string; // UTC ISO
  lastSeenPage: string | null;
}

const ONLINE_WHERE = `u.status = 'active' and u.last_seen > now() - make_interval(mins => $1)`;
const likeArg = (q: string) => `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Online users, most-recently-active first, optional name/email search, paginated. */
export async function listOnlineUsers(offset: number, limit: number, q?: string, windowMins: number = ONLINE_WINDOW_MINUTES): Promise<OnlineUser[]> {
  const search = q && q.trim() ? q : null;
  const { rows } = await pool.query<{ id: string; display_name: string; email: string; avatar: string | null; last_seen: string; last_seen_page: string | null }>(
    `select u.id, u.display_name, u.email, u.avatar, u.last_seen, u.last_seen_page
       from users u
      where ${ONLINE_WHERE}
        ${search ? `and (u.display_name ilike $4 escape '\\' or u.email ilike $4 escape '\\')` : ""}
      order by u.last_seen desc
      limit $2 offset $3`,
    search ? [windowMins, limit, offset, likeArg(search)] : [windowMins, limit, offset],
  );
  return rows.map((r) => ({
    userId: r.id,
    displayName: userLabel(r.display_name, r.email),
    email: r.email,
    avatar: r.avatar,
    lastSeen: new Date(r.last_seen).toISOString(),
    lastSeenPage: r.last_seen_page,
  }));
}

/** Total online users matching the optional search (for the live count + hasMore). */
export async function countOnlineUsers(q?: string, windowMins: number = ONLINE_WINDOW_MINUTES): Promise<number> {
  const search = q && q.trim() ? q : null;
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n
       from users u
      where ${ONLINE_WHERE}
        ${search ? `and (u.display_name ilike $2 escape '\\' or u.email ilike $2 escape '\\')` : ""}`,
    search ? [windowMins, likeArg(search)] : [windowMins],
  );
  return Number(rows[0]?.n ?? 0);
}

export interface ActiveUserCounts {
  /** distinct active users, last_seen within the trailing 24 hours */
  dau: number;
  /** trailing 7 days */
  wau: number;
  /** trailing 30 days */
  mau: number;
}

/**
 * Live DAU/WAU/MAU — rolling trailing windows off the SAME `last_seen` signal as "Currently
 * online" (any authenticated request; SKILLY_SPEC.md §4), not a historical log: last_seen only
 * ever holds each user's most recent activity, so this answers "how many right now", never "what
 * was it on a past date". One query, three `count(*) filter` aggregates over the same scan.
 */
export async function getActiveUserCounts(): Promise<ActiveUserCounts> {
  const { rows } = await pool.query<{ dau: string; wau: string; mau: string }>(
    `select
       count(*) filter (where last_seen > now() - interval '24 hours')::text as dau,
       count(*) filter (where last_seen > now() - interval '7 days')::text  as wau,
       count(*) filter (where last_seen > now() - interval '30 days')::text as mau
     from users
    where status = 'active'`,
  );
  const r = rows[0];
  return { dau: Number(r?.dau ?? 0), wau: Number(r?.wau ?? 0), mau: Number(r?.mau ?? 0) };
}

export type DauRange = 7 | 30 | 90 | "all";
export interface DauPoint { date: string; count: number }
export interface DauSeries { range: DauRange; bucket: "day" | "week" | "month"; points: DauPoint[] }

// Fixed mapping (not span-adaptive like the per-skill usage chart) — there are only 4 range
// choices here, so the bucket for each is decided up front: 7d/30d stay daily (readable as-is),
// 90d rolls into weekly averages, "all" into monthly — SKILLY_SPEC.md §4.
const DAU_BUCKET: Record<DauRange, "day" | "week" | "month"> = { 7: "day", 30: "day", 90: "week", all: "month" };

/**
 * The daily_active_users trend chart's data (§4). Historical rows only — no zero-filling for
 * days the daily snapshot job hasn't run yet (e.g. right after this feature ships), so a fresh
 * deployment shows a short, growing line rather than a manufactured flat one. Week/month buckets
 * average the daily counts within the bucket (a sum would be meaningless for a "how many people"
 * metric).
 */
export async function getActiveUserSeries(range: DauRange): Promise<DauSeries> {
  const bucket = DAU_BUCKET[range];
  if (bucket === "day") {
    const { rows } = await pool.query<{ day: string; n: string }>(
      `select day::text as day, count::text as n
         from daily_active_users
        where day > current_date - make_interval(days => $1)
        order by day asc`,
      [range as number],
    );
    return { range, bucket, points: rows.map((r) => ({ date: r.day, count: Number(r.n) })) };
  }
  if (bucket === "week") {
    const { rows } = await pool.query<{ day: string; n: string }>(
      `select date_trunc('week', day)::date::text as day, avg(count)::int::text as n
         from daily_active_users
        where day > current_date - interval '90 days'
        group by 1 order by 1 asc`,
    );
    return { range, bucket, points: rows.map((r) => ({ date: r.day, count: Number(r.n) })) };
  }
  // "all" — monthly average across the whole collected history.
  const { rows } = await pool.query<{ day: string; n: string }>(
    `select date_trunc('month', day)::date::text as day, avg(count)::int::text as n
       from daily_active_users
      group by 1 order by 1 asc`,
  );
  return { range, bucket, points: rows.map((r) => ({ date: r.day, count: Number(r.n) })) };
}
