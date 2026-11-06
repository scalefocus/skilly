// New users (SKILLY_SPEC.md §67.3): the page-wide map behind the propeller-beanie hat every
// `UserBubble` draws. Modelled on `lib/levels.ts` — one cached map per page, so a leaderboard with a
// hundred bubbles issues one request, not a hundred.
//
// Unlike the level map there is NO per-caller merge: Visits, New user and the hat are
// viewer-independent (§67.1 decision 8), so an opted-out caller is absent from their own view too,
// exactly as their card hides the rows.
import type { Pool } from "pg";
import { pool } from "./db";
import { createTtlCache } from "./ttlCache";
import { NEW_USER_DAYS } from "@skilly/shared/visits";

export interface NewcomerMap {
  /** Users whose first visit is within the last 30 days: active, not erased, not opted out. */
  ids: string[];
}

const NEWCOMERS_TTL_MS = Number(process.env.NEWCOMERS_CACHE_TTL_MS ?? 60_000);
const newcomersCache = createTtlCache<NewcomerMap>(NEWCOMERS_TTL_MS);

/** The public map. Opted-out, inactive and erased users are omitted here rather than filtered in the
 *  browser — that omission is the privacy mechanism. */
async function computeNewcomers(db: Pool): Promise<NewcomerMap> {
  const { rows } = await db.query<{ id: string }>(
    `select id from users
      where status = 'active' and erased_at is null and directory_hidden = false
        and first_seen is not null and first_seen > now() - make_interval(days => $1::int)
      order by first_seen desc`,
    [NEW_USER_DAYS],
  );
  return { ids: rows.map((r) => r.id) };
}

/** Drop the cached map so an opt-out or an erasure shows on the next request instead of after the
 *  TTL (best-effort, this web process only). */
export function invalidateNewcomers(): void {
  newcomersCache.clear();
}

/**
 * The newcomer map, or `{ ids: [] }` while the `visits_enabled` switch is off — the hat disappears
 * everywhere with the card rows (§67.6). A non-default `db` (tests) bypasses the cache.
 */
export async function getNewcomers(enabled: boolean, db: Pool = pool): Promise<NewcomerMap> {
  if (!enabled) return { ids: [] };
  if (db !== pool) return computeNewcomers(db);
  return newcomersCache.get("all", () => computeNewcomers(pool));
}
