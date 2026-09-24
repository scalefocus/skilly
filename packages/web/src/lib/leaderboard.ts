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
// skillsRequested (§26) is the one metric a person generates entirely by themselves: the count of
// their own skill_requests rows in any persisting state (open/fulfilled — withdrawn/removed
// hard-delete, so a withdrawal or an admin removal drops the count at once), windowed on the
// request's created_at. No self-credit rule applies (there is no other party to exclude) and no
// threshold gates it; the check on gaming is that requests are org-visible and admin-removable.
//
// followers (§35.7) counts user_follows rows on the user whose follower is active and not erased
// (a deactivated follower drops out; re-enabling restores them). All-time = the current count; 30d =
// follows created in the trailing 30 days that still exist. A user who PAUSED follows
// (allow_follows = false) reads 0 — not shown, not ranked, no follow leader badge. Aggregate only:
// the board never says WHO follows anyone.
//
// The board exposes only per-person AGGREGATES (display name, total installs, skill count) —
// never skill identities, slugs, or namespaces — so it can't be used to enumerate or identify
// restricted skills (the concern behind invariant #3). It is therefore identical for every
// viewer. Users who opt out (leaderboard_hidden) or are erased (credits deleted, status inactive)
// are omitted.
import { pool } from "./db";
import { createTtlCache } from "./ttlCache";

export type LeaderboardWindow = "all" | "30d";
/** Ranking metric (§26/§35.7): installs credited (default) / distinct skills / skill requests fulfilled / skills watched / skills requested / followers. */
export type LeaderboardSort = "installs" | "skills" | "requests" | "watched" | "requested" | "followed";

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
  /** Skill requests this user posted, in any persisting state (open/fulfilled), by created_at. §26. */
  skillsRequested: number;
  /** Active followers (§35.7) — 0 while the user has paused follows. */
  followers: number;
  /** §35.4 — viewer-independent, so the per-(window,sort) cache stays shared. */
  followable: boolean;
}

// The board is viewer-independent and runs a heavy 3-CTE aggregate over proposals + access_log,
// so cache the result per (window, sort) for a short window. A bypassCache read forces a fresh query.
const LB_TTL_MS = Number(process.env.LEADERBOARD_CACHE_TTL_MS ?? 60_000);
const leaderboardCache = createTtlCache<LeaderboardEntry[]>(LB_TTL_MS);

/** The board shows at most the top LEADERBOARD_LIMIT contributors for the selected metric+window
 *  (§21). A fixed platform constant, NOT a caller-supplied value — neither the API nor the page can
 *  raise or lower it; the deterministic ORDER BY (metric desc, other metrics desc, name asc) makes
 *  the ≤100 rows that survive the cut stable across requests. */
export const LEADERBOARD_LIMIT = 100;

export async function getLeaderboard(
  window: LeaderboardWindow = "all",
  sort: LeaderboardSort = "installs",
  opts: { bypassCache?: boolean } = {},
): Promise<LeaderboardEntry[]> {
  // Always the top LEADERBOARD_LIMIT rows; the only knob is whether to serve from the shared TTL
  // cache (default) or force a fresh query — tests that seed credits want to read their own writes.
  if (opts.bypassCache) return computeLeaderboard(window, sort);
  return leaderboardCache.get(`${window}:${sort}`, () => computeLeaderboard(window, sort));
}

/** Drop the cached boards so a membership change (opt in/out) shows on the next request, for
 *  ALL window/sort variants at once (they have independent TTLs, so clearing one isn't enough). */
export function invalidateLeaderboard(): void {
  leaderboardCache.clear();
}

async function computeLeaderboard(window: LeaderboardWindow, sort: LeaderboardSort): Promise<LeaderboardEntry[]> {
  // 30d variant counts only activity in the trailing 30 days; "all" counts everything. Install
  // credit filters on the install's timestamp (access_log.created_at); requests-fulfilled on
  // fulfilled_at — both snapshots, so later user changes never move past credit.
  const sinceInstalls = window === "30d" ? "and al.created_at >= now() - interval '30 days'" : "";
  const sinceFulfilled = window === "30d" ? "and fulfilled_at >= now() - interval '30 days'" : "";
  const sinceWatched = window === "30d" ? "and sw.created_at >= now() - interval '30 days'" : "";
  const sinceRequested = window === "30d" ? "and created_at >= now() - interval '30 days'" : "";
  const sinceFollowed = window === "30d" ? "and uf.created_at >= now() - interval '30 days'" : "";
  // A user appears with ANY kind of credit, so a pure request-fulfiller or a maintainer whose only
  // credit is a watched skill still ranks when sorting by that metric. Ties break by the other
  // metrics, then name (§26). NOTE: these bare names bind to the SELECT output aliases (Postgres
  // resolves ORDER BY names against output columns first), so every metric column must stay
  // numeric — a text-typed alias would sort lexicographically ("9" above "80").
  const orderBy = leaderboardOrderBy(sort);
  const { rows } = await pool.query<{
    user_id: string; display_name: string; email: string; avatar: string | null;
    skill_count: number; installs: number; requests_fulfilled: number; skills_watched: number; skills_requested: number;
    followers: number; followable: boolean;
  }>(
    // Each install_credits row = one credited install; skillCount = distinct skills behind them.
    // requests_fulfilled = fulfilled skill_requests where this user built the skill and the
    // requester is someone else (no self-credit, §26). skills_watched = distinct skills this user
    // EXPLICITLY maintains (skill_maintainers — implicit namespace-admin maintainership earns
    // nothing, same rule as install credits) that have a watcher other than that maintainer;
    // the self-watch exclusion is per-maintainer, so a co-maintainer's own watch still counts
    // toward the OTHER maintainer's total. skills_requested = the user's own skill_requests rows in
    // any persisting state, by created_at (§26) — no self-credit rule, nothing to exclude.
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
     ), requested as (
       select requester_user_id as user_id, count(*) as skills_requested
         from skill_requests
        where state in ('open', 'fulfilled') ${sinceRequested}
        group by requester_user_id
     ), followed as (
       select uf.followee_id as user_id, count(*) as followers
         from user_follows uf
         join users fu on fu.id = uf.follower_id and fu.status = 'active' and fu.erased_at is null
        where true ${sinceFollowed}
        group by uf.followee_id
     )
     select u.id as user_id, u.display_name, u.email, u.avatar,
            coalesce(c.skill_count, 0)::int as skill_count,
            coalesce(c.installs, 0)::int as installs,
            coalesce(f.requests_fulfilled, 0)::int as requests_fulfilled,
            coalesce(w.skills_watched, 0)::int as skills_watched,
            coalesce(rq.skills_requested, 0)::int as skills_requested,
            (case when u.allow_follows then coalesce(fo.followers, 0) else 0 end)::int as followers,
            (u.status = 'active' and u.erased_at is null and u.allow_follows) as followable
       from users u
       left join credits c on c.user_id = u.id
       left join fulfilled f on f.user_id = u.id
       left join watched w on w.user_id = u.id
       left join requested rq on rq.user_id = u.id
       left join followed fo on fo.user_id = u.id and u.allow_follows
      where u.status = 'active' and u.leaderboard_hidden = false
        and (c.user_id is not null or f.user_id is not null or w.user_id is not null or rq.user_id is not null or fo.user_id is not null)
      order by ${orderBy}
      limit $1`,
    [LEADERBOARD_LIMIT],
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
    skillsRequested: r.skills_requested,
    followers: r.followers,
    followable: r.followable === true,
  }));
}

/**
 * The ORDER BY for a sort (§26 / §35.7): the chosen metric first, then the other metrics in the
 * fixed order installs, skills adopted, requests fulfilled, skills watched, skills requested,
 * followers, then name. NOTE: these bare names bind to the SELECT output aliases (Postgres resolves
 * ORDER BY names against output columns first), so every metric column must stay numeric — a
 * text-typed alias would sort lexicographically ("9" above "80"). Exported for the unit test.
 */
export function leaderboardOrderBy(sort: LeaderboardSort): string {
  const chain = ["installs", "skill_count", "requests_fulfilled", "skills_watched", "skills_requested", "followers"];
  const primary: Record<LeaderboardSort, string> = {
    installs: "installs",
    skills: "skill_count",
    requests: "requests_fulfilled",
    watched: "skills_watched",
    requested: "skills_requested",
    followed: "followers",
  };
  const first = primary[sort] ?? "installs";
  return [first, ...chain.filter((c) => c !== first)].map((c) => `${c} desc`).concat("display_name asc").join(", ");
}
