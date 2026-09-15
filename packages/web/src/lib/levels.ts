// Achievement levels (SKILLY_SPEC.md §31.10): the bulk map behind the ring every `UserBubble`
// draws. Deliberately modelled on `lib/leaders.ts` — one cached map for the whole page, so a
// leaderboard with a hundred bubbles issues exactly one request instead of a hundred.
//
// A "level" is nothing but how many badges a user has earned; "Hero" is the stored `users.hero_at`
// stamp, never a live `count = catalog size` comparison (a grown catalog must not un-Hero anyone).
import type { Pool } from "pg";
import { pool } from "./db";
import { createTtlCache } from "./ttlCache";

export interface LevelMap {
  /** userId → badge count. Only users at level ≥ 1: level 0 renders no ring. */
  levels: Record<string, number>;
  /** The ids whose `hero_at` is stamped — they draw the crowned ring. */
  heroes: string[];
}

const EMPTY: LevelMap = { levels: {}, heroes: [] };

// Same two-layer shape as the leader badges: a short server-side TTL under the shared client-side
// GET cache. The query is one grouped count over an already-PK-indexed table.
const LEVELS_TTL_MS = Number(process.env.LEVELS_CACHE_TTL_MS ?? 60_000);
const levelsCache = createTtlCache<LevelMap>(LEVELS_TTL_MS);

/**
 * The PUBLIC map: active, non-erased, non-hidden users at level ≥ 1.
 *
 * Opted-out users are omitted here rather than filtered in the browser — that omission IS the
 * privacy mechanism (§31.10). The caller's own row is merged back in by `getLevelMapFor` so the
 * cache stays shareable across viewers.
 */
async function computeLevels(db: Pool): Promise<LevelMap> {
  const { rows } = await db.query<{ user_id: string; n: string; hero: boolean }>(
    `select ua.user_id, count(*)::text as n, (u.hero_at is not null) as hero
       from user_achievements ua
       join users u on u.id = ua.user_id
      where u.erased_at is null and u.status = 'active' and u.achievements_hidden = false
      group by ua.user_id, u.hero_at`,
  );
  const map: LevelMap = { levels: {}, heroes: [] };
  for (const r of rows) {
    const n = Number(r.n);
    if (n < 1) continue;
    map.levels[r.user_id] = n;
    if (r.hero) map.heroes.push(r.user_id);
  }
  return map;
}

/** Drop the cached map so an opt-in/out, an erasure or a deprovision shows on the next request
 *  instead of after the TTL lapses — the same courtesy `invalidateLeaderboard()` does for the
 *  board (best-effort, this web process only). */
export function invalidateLevels(): void {
  levelsCache.clear();
}

/** One row for a single user, bypassing the shared cache — used for the caller's own entry. */
async function ownLevel(db: Pool, userId: string): Promise<{ level: number; hero: boolean }> {
  const { rows } = await db.query<{ n: string; hero: boolean }>(
    `select (select count(*) from user_achievements ua where ua.user_id = u.id)::text as n,
            (u.hero_at is not null) as hero
       from users u
      where u.id = $1 and u.erased_at is null and u.status = 'active'`,
    [userId],
  );
  const r = rows[0];
  return { level: r ? Number(r.n) : 0, hero: !!r?.hero };
}

/**
 * The map as `viewerId` should see it: the cached public map plus the viewer's own level even when
 * they have opted out — §31.5's "while hidden, the owner still sees their full card" applies to the
 * ring on their own avatar too. `{}` while the platform toggle is off, so the ring disappears
 * everywhere with the rest of the feature (§31.7).
 */
export async function getLevelMapFor(
  viewerId: string,
  enabled: boolean,
  opts: { bypassCache?: boolean } = {},
  db: Pool = pool,
): Promise<LevelMap> {
  if (!enabled) return EMPTY;
  // bypassCache forces a fresh query past the module-level TTL — tests that seed badges want to
  // read their own writes, exactly as the leaderboard's own reader does.
  const base = opts.bypassCache ? await computeLevels(db) : await levelsCache.get("map", () => computeLevels(db));
  if (base.levels[viewerId] !== undefined) return base;
  const own = await ownLevel(db, viewerId);
  if (own.level < 1) return base;
  return {
    levels: { ...base.levels, [viewerId]: own.level },
    heroes: own.hero ? [...base.heroes, viewerId] : base.heroes,
  };
}
