// Contributor leaderboard (SKILLY_SPEC.md §21). Ranks users by the installs CREDITED to them as
// an explicit MAINTAINER of the installed skill. Each install is counted ONCE per (user, skill)
// — a user's FIRST install only (re-clones never re-credit), and a maintainer installing a skill
// they maintain earns NO self-credit — so the board can't be inflated by re-installing (§21).
// The first install is attributed AT THAT TIME to every (other) explicit maintainer of the skill
// then, snapshotted into install_credits by record_git_access()/record_skill_download() — so a
// maintainer change never moves past credit (removal stops only future credit). Implicit
// namespace-admin maintainership earns nothing. One install with N maintainers yields +1 for each
// (equal credit), so the board's summed installs exceed the unique-install count — this is
// "installs credited to you", not a global total.
//
// Both displayed metrics derive from install_credits (always mutually consistent): installs =
// unique installs credited to you in the window; skillCount = distinct skills among them.
//
// skillsWatched (§26) follows the same self-credit rule as installs, applied to skill_watches
// instead of access_log: a skill you explicitly maintain counts toward your total only if
// someone OTHER than you watches it, checked per-maintainer (a co-maintainer's own watch still
// counts for the other maintainer). Implicit namespace-admin maintainership earns nothing here
// either, consistent with install-credit attribution.
//
// The board exposes only per-person AGGREGATES (display name, total installs, skill count) —
// never skill identities, slugs, or namespaces — so it can't be used to enumerate or identify
// restricted skills (the concern behind invariant #3). It is therefore identical for every
// viewer. Users who opt out (leaderboard_hidden) or are erased (credits deleted, status inactive)
// are omitted.
import { pool } from "./db";
import { createTtlCache } from "./ttlCache";

export type LeaderboardWindow = "all" | "30d";
/** Ranking metric (§26): installs credited (default) / distinct skills / skill requests fulfilled / skills watched. */
export type LeaderboardSort = "installs" | "skills" | "requests" | "watched";

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  email: string;
  avatar: string | null;
  skillCount: number;
  installs: number;
  /** Skill requests this user fulfilled (accepted a linked proposal; self-requests excluded). §26. */
  requestsFulfilled: number;
  /** Distinct skills this user explicitly maintains that are watched by someone OTHER than
   *  themselves (per-maintainer self-watch exclusion — a co-maintainer's watch still counts). §26. */
  skillsWatched: number;
}

// The board is viewer-independent and runs a heavy 3-CTE aggregate over proposals + access_log,
// so cache the default-page result per (window, sort) for a short window. Custom limits bypass it.
const LB_TTL_MS = Number(process.env.LEADERBOARD_CACHE_TTL_MS ?? 60_000);
const leaderboardCache = createTtlCache<LeaderboardEntry[]>(LB_TTL_MS);

export async function getLeaderboard(window: LeaderboardWindow = "all", sort: LeaderboardSort = "installs", limit = 100): Promise<LeaderboardEntry[]> {
  if (limit === 100) return leaderboardCache.get(`${window}:${sort}`, () => computeLeaderboard(window, sort, limit));
  return computeLeaderboard(window, sort, limit);
}

/** Drop the cached boards so a membership change (opt in/out) shows on the next request, for
 *  ALL window/sort variants at once (they have independent TTLs, so clearing one isn't enough). */
export function invalidateLeaderboard(): void {
  leaderboardCache.clear();
}

async function computeLeaderboard(window: LeaderboardWindow, sort: LeaderboardSort, limit: number): Promise<LeaderboardEntry[]> {
  // 30d variant counts only activity in the trailing 30 days; "all" counts everything. Install
  // credit filters on the install's timestamp (access_log.created_at); requests-fulfilled on
  // fulfilled_at — both snapshots, so later user changes never move past credit.
  const sinceInstalls = window === "30d" ? "and al.created_at >= now() - interval '30 days'" : "";
  const sinceFulfilled = window === "30d" ? "and fulfilled_at >= now() - interval '30 days'" : "";
  const sinceWatched = window === "30d" ? "and sw.created_at >= now() - interval '30 days'" : "";
  // A user appears with ANY kind of credit, so a pure request-fulfiller or a maintainer whose only
  // credit is a watched skill still ranks when sorting by that metric. Ties break by the other
  // metrics, then name (§26). NOTE: these bare names bind to the SELECT output aliases (Postgres
  // resolves ORDER BY names against output columns first), so every metric column must stay
  // numeric — a text-typed alias would sort lexicographically ("9" above "80").
  const orderBy =
    sort === "requests"
      ? "requests_fulfilled desc, installs desc, skill_count desc, skills_watched desc, display_name asc"
      : sort === "skills"
        ? "skill_count desc, installs desc, requests_fulfilled desc, skills_watched desc, display_name asc"
        : sort === "watched"
          ? "skills_watched desc, installs desc, skill_count desc, requests_fulfilled desc, display_name asc"
          : "installs desc, skill_count desc, requests_fulfilled desc, skills_watched desc, display_name asc";
  const { rows } = await pool.query<{
    user_id: string; display_name: string; email: string; avatar: string | null;
    skill_count: number; installs: number; requests_fulfilled: number; skills_watched: number;
  }>(
    // Each install_credits row = one credited install; skillCount = distinct skills behind them.
    // requests_fulfilled = fulfilled skill_requests where this user built the skill and the
    // requester is someone else (no self-credit, §26). skills_watched = distinct skills this user
    // EXPLICITLY maintains (skill_maintainers — implicit namespace-admin maintainership earns
    // nothing, same rule as install credits) that have a watcher other than that maintainer;
    // the self-watch exclusion is per-maintainer, so a co-maintainer's own watch still counts
    // toward the OTHER maintainer's total.
    `with credits as (
       select ic.user_id, count(*) as installs, count(distinct al.skill_id) as skill_count
         from install_credits ic
         join access_log al on al.id = ic.access_log_id and al.source = 'git' ${sinceInstalls}
        group by ic.user_id
     ), fulfilled as (
       select fulfilled_by_user_id as user_id, count(*) as requests_fulfilled
         from skill_requests
        where state = 'fulfilled' and fulfilled_by_user_id is not null
          and fulfilled_by_user_id <> requester_user_id ${sinceFulfilled}
        group by fulfilled_by_user_id
     ), watched as (
       select sm.user_id, count(distinct sm.skill_id) as skills_watched
         from skill_maintainers sm
         join skill_watches sw on sw.skill_id = sm.skill_id and sw.user_id <> sm.user_id ${sinceWatched}
        group by sm.user_id
     )
     select u.id as user_id, u.display_name, u.email, u.avatar,
            coalesce(c.skill_count, 0)::int as skill_count,
            coalesce(c.installs, 0)::int as installs,
            coalesce(f.requests_fulfilled, 0)::int as requests_fulfilled,
            coalesce(w.skills_watched, 0)::int as skills_watched
       from users u
       left join credits c on c.user_id = u.id
       left join fulfilled f on f.user_id = u.id
       left join watched w on w.user_id = u.id
      where u.status = 'active' and u.leaderboard_hidden = false
        and (c.user_id is not null or f.user_id is not null or w.user_id is not null)
      order by ${orderBy}
      limit $1`,
    [Math.min(200, limit)],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    email: r.email,
    avatar: r.avatar,
    skillCount: r.skill_count,
    installs: r.installs,
    requestsFulfilled: r.requests_fulfilled,
    skillsWatched: r.skills_watched,
  }));
}
