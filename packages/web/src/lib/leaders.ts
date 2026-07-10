// Leader badges: a small "you're #1" marker shown under a user's avatar bubble everywhere one
// appears (SKILLY_SPEC.md §21 extension). Four metrics — the same ones the leaderboard already
// ranks by (installs / skills proposed / requests fulfilled / skills watched) — each in two
// windows (all-time / last-30-days), so up to 8 badges per user. A user is a "leader" for a
// metric+window when they're tied for the TOP value of that metric in that window (ties all get
// the badge — a tie is a tie); a metric with nobody above zero has no leader at all.
//
// Reuses the already-cached per-(window,sort) leaderboard query — each metric's top rows are a
// query the board already runs and caches, so this adds no new SQL. Since every sort order lists
// its primary metric in strictly non-increasing order, the tied-for-first rows are exactly the
// contiguous prefix where that metric equals the first row's value.
import { getLeaderboard, type LeaderboardEntry, type LeaderboardSort, type LeaderboardWindow } from "./leaderboard";
import { createTtlCache } from "./ttlCache";

export type LeaderMetric = "installs" | "skills" | "requests" | "watched";

export interface LeaderBadge {
  metric: LeaderMetric;
  window: LeaderboardWindow;
}

const METRICS: { metric: LeaderMetric; sort: LeaderboardSort; value: (e: LeaderboardEntry) => number }[] = [
  { metric: "installs", sort: "installs", value: (e) => e.installs },
  { metric: "skills", sort: "skills", value: (e) => e.skillCount },
  { metric: "requests", sort: "requests", value: (e) => e.requestsFulfilled },
  { metric: "watched", sort: "watched", value: (e) => e.skillsWatched },
];
const WINDOWS: LeaderboardWindow[] = ["all", "30d"];

// Short TTL cache around the whole map — the underlying per-(window,sort) calls are themselves
// cached (leaderboard.ts, 60s), so this is mostly free; the cache just avoids rebuilding the map
// object and re-touching all 8 cache entries on every single page load's avatar batch.
const LEADERS_TTL_MS = Number(process.env.LEADERS_CACHE_TTL_MS ?? 30_000);
const leadersCache = createTtlCache<Record<string, LeaderBadge[]>>(LEADERS_TTL_MS);

export async function getLeaderBadges(): Promise<Record<string, LeaderBadge[]>> {
  return leadersCache.get("map", computeLeaderBadges);
}

async function computeLeaderBadges(): Promise<Record<string, LeaderBadge[]>> {
  const map: Record<string, LeaderBadge[]> = {};
  for (const window of WINDOWS) {
    for (const m of METRICS) {
      const rows = await getLeaderboard(window, m.sort, 100);
      const top = rows.length ? m.value(rows[0]!) : 0;
      if (top <= 0) continue; // nobody has any — no leader for this metric+window
      for (const r of rows) {
        if (m.value(r) !== top) break; // rows are sorted desc by this metric first — ties are a prefix
        (map[r.userId] ??= []).push({ metric: m.metric, window });
      }
    }
  }
  return map;
}
