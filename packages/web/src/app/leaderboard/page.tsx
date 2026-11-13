"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { HypedBoard } from "./HypedBoard";
import { useApi, EmptyState, ScrollToTop, formatCount } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { UserBubble } from "../../components/UserBubble";
import { FollowButton } from "../../components/FollowButton";
import { reportFeatureUse } from "../../lib/surveyClient";
import { DEFAULT_SORT, LB_AVATAR, LB_MAX_BADGES, LB_MAX_BADGES_COMPACT, SORTS, avatarSlot, isCompactBoard, statLine, type Entry, type Sort } from "./board";

/**
 * §21 "Narrow screens": whether the board is too narrow for the desktop columns. Measured on the
 * board element itself, so it holds on a phone, on a tablet, and in a window the sidebar has
 * squeezed. Returns a ref for the board and the answer. The first measurement runs in the ref
 * callback (commit phase), so the board never paints in the wrong layout; its width comes from
 * the page, not from its rows, so switching layout cannot change the measurement.
 */
function useCompactBoard(): [(el: HTMLDivElement | null) => void, boolean] {
  const [compact, setCompact] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const sync = () => setCompact(isCompactBoard(el.getBoundingClientRect().width));
    sync();
    observer.current = new ResizeObserver(sync);
    observer.current.observe(el);
  }, []);
  return [ref, compact];
}

// §50.6 two tabs: People (the contributor board, unchanged) and Hyped skills. `?tab=hyped` opens
// the second (the home page's "see the board" link). The Hyped tab is hidden while hype is off.
function LeaderboardTabs() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = params.get("tab") === "hyped" ? "hyped" : "people";
  const { data: me } = useApi<{ hypeEnabled?: boolean }>("/api/me");
  const hypeOn = me?.hypeEnabled !== false;
  const showHyped = hypeOn && tab === "hyped";
  return (
    // 980 px, the width of the usage dashboard and the admin logs (§21 "Row layout"); both tabs share it.
    <div style={{ maxWidth: 980 }}>
      <ScrollToTop />
      <div className="page-head reveal">
        <div className="eyebrow">Community</div>
        <h1 className="page-title">Leaderboard.</h1>
        {!showHyped && <p className="page-sub">Ranked by skills installed: the skills each person has installed themselves. Installs received counts other people’s first installs of the skills someone maintains. Skills that arrive through a plugin marketplace are not counted.</p>}
      </div>
      {hypeOn && (
        <div className="sort-toggle" role="tablist" aria-label="Leaderboard" style={{ marginBottom: 16 }}>
          <button type="button" role="tab" aria-selected={!showHyped} className={`sort-opt${!showHyped ? " sort-on" : ""}`} onClick={() => router.replace("/leaderboard")}>People</button>
          <button type="button" role="tab" aria-selected={showHyped} className={`sort-opt${showHyped ? " sort-on" : ""}`} onClick={() => router.replace("/leaderboard?tab=hyped")}>Hyped skills</button>
        </div>
      )}
      {showHyped ? <HypedBoard /> : <Leaderboard />}
    </div>
  );
}

function Leaderboard() {
  // §36.3 opening the leaderboard is the `leaderboard` feature's first use.
  useEffect(() => { reportFeatureUse("leaderboard"); }, []);
  const [window, setWindow] = useState<"all" | "30d">("all");
  // Ranking metric (./board): Installed, a person’s own installs, is the default.
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const active = SORTS.find((s) => s.key === sort) ?? SORTS[0]!;
  // §21 "Narrow screens": a narrow board shows 2 leader badges, so the name gets the width.
  const [boardRef, compact] = useCompactBoard();
  const maxBadges = compact ? LB_MAX_BADGES_COMPACT : LB_MAX_BADGES;
  const slot = avatarSlot(maxBadges);
  const { data, loading, error } = useApi<{ entries: Entry[] }>(`/api/leaderboard?window=${window}&sort=${sort}`);
  // Current user's id → identify your own row (hide "Reach out" on it; link "Skills" to My Skills and "Requests" to Mine).
  const { data: me } = useApi<{ userId: string | null }>("/api/me");
  const entries = data?.entries ?? [];

  // "Reach out": open (or reuse) a 1:1 chat — same flow as the maintainer list / online users.
  // NOTE: the `window` state above shadows the global, so dispatch via globalThis.
  const [reaching, setReaching] = useState<string | null>(null);
  const reachOut = async (userId: string) => {
    setReaching(userId);
    try {
      const r = await fetch("/api/messages/direct", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
      if (r.ok) {
        const { conversationId } = await r.json();
        globalThis.dispatchEvent(new CustomEvent("skilly:open-conversation", { detail: { id: conversationId } }));
      }
    } finally {
      setReaching(null);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <div className="sort-toggle" role="group" aria-label="Rank by">
          {SORTS.map((s) => (
            <button key={s.key} type="button" className={`sort-opt${sort === s.key ? " sort-on" : ""}`} onClick={() => setSort(s.key)}>{s.label}</button>
          ))}
        </div>
        <div className="sort-toggle" role="group" aria-label="Leaderboard window">
          <button type="button" className={`sort-opt${window === "all" ? " sort-on" : ""}`} onClick={() => setWindow("all")}>All time</button>
          <button type="button" className={`sort-opt${window === "30d" ? " sort-on" : ""}`} onClick={() => setWindow("30d")}>Last 30 days</button>
        </div>
      </div>

      {error ? (
        <EmptyState icon="⚠" title="Couldn’t load the leaderboard" hint={error} />
      ) : loading ? (
        <div className="skeleton" style={{ height: 240, borderRadius: "var(--radius)" }} />
      ) : entries.length === 0 ? (
        <EmptyState title="No contributors yet" hint="Once proposals are accepted and skills get installed, they’ll rank here." />
      ) : (
        <div ref={boardRef} className={`rows reveal lb-people${compact ? " lb-compact" : ""}`}>
          {entries.map((e, i) => {
            const isSelf = !!me?.userId && me.userId === e.userId;
            // Your own row → the catalog's "My Skills" filter; anyone else → the maintained-by view
            // (banner shows their name). Both list only skills the viewer can see (§19/§21).
            const skillsHref = isSelf ? "/catalog?mine=1" : `/catalog?maintainer=${e.userId}&by=${encodeURIComponent(e.displayName)}`;
            // Your own row → the requests page's "Mine" toggle; anyone else → the requested-by view
            // (banner shows their name). Requests have no namespace, so nothing to visibility-filter (§21/§26).
            const requestsHref = isSelf ? "/requests?mine=1" : `/requests?requester=${e.userId}&by=${encodeURIComponent(e.displayName)}`;
            const stats = statLine(e);
            // §21 "Row layout": rank · avatar · name and stat line · number · actions. The number and
            // action columns are fixed width, so the name column is the same on every row.
            return (
            <div className="row lb-row" key={e.userId}>
              <span className="mono lb-rank" style={{ color: i < 3 ? "var(--accent-2)" : "var(--faint)" }}>
                {i + 1}
              </span>
              <div className="lb-av" style={{ width: slot.width, height: slot.height }}>
                <UserBubble name={e.displayName} avatar={e.avatar} userId={e.userId} size={LB_AVATAR} maxBadges={maxBadges} />
              </div>
              <div className="lb-who">
                <div className="lb-line lb-name" title={e.displayName}>{e.displayName}</div>
                <div className="lb-line lb-stats muted mono" title={stats}>{stats}</div>
              </div>
              <div className="lb-num">
                <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600 }}>
                  {formatCount(active.value(e))}
                </div>
                <div className="muted mono" style={{ fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                  {active.caption}
                </div>
              </div>
              {/* §21 "Action slots": four slots, always rendered, so every button sits at the same
                  place on every row; a missing action leaves its slot empty. */}
              <div className="lb-actions">
                <span className="lb-slot">
                  <Link href={skillsHref} className="btn btn-sm" title={isSelf ? "Your maintained skills" : `Skills maintained by ${e.displayName}`}>Skills</Link>
                </span>
                <span className="lb-slot">
                  <Link href={requestsHref} className="btn btn-sm" title={isSelf ? "Your skill requests" : `Skills requested by ${e.displayName}`}>Requests</Link>
                </span>
                <span className="lb-slot">
                  {!isSelf && (
                    <button type="button" className="btn btn-sm" disabled={reaching === e.userId} onClick={() => reachOut(e.userId)} title={`Message ${e.displayName}`}>
                      {reaching === e.userId ? "…" : "Reach out"}
                    </button>
                  )}
                </span>
                <span className="lb-slot">
                  {/* §35.4 — right of Reach out; renders nothing on your own row or for the unfollowable. */}
                  <FollowButton userId={e.userId} followable={e.followable} name={e.displayName} />
                </span>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function LeaderboardPage() {
  return (
    <RequireAuth>
      <Suspense fallback={<div className="skeleton" style={{ height: 240, borderRadius: "var(--radius)" }} />}>
        <LeaderboardTabs />
      </Suspense>
    </RequireAuth>
  );
}
