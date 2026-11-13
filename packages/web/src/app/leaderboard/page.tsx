"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { HypedBoard } from "./HypedBoard";
import { useApi, EmptyState, ScrollToTop, formatCount } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { UserBubble } from "../../components/UserBubble";
import { FollowButton } from "../../components/FollowButton";
import { reportFeatureUse } from "../../lib/surveyClient";

interface Entry {
  userId: string;
  displayName: string;
  email: string;
  avatar: string | null;
  skillCount: number;
  installs: number;
  requestsFulfilled: number;
  skillsWatched: number;
  skillsRequested: number;
  /** Active followers (§35.7) — 0 while the person has paused follows. */
  followers: number;
  /** Collections holding at least 3 eligible skills (§38.8). */
  collections: number;
  /** Skills this person installed themselves, one per skill (§21 "Skills installed"). */
  skillsInstalled: number;
  followable: boolean;
}

// The ranking metrics, in toggle order (§21/§26/§35.7/§38.8): the button label, the caption under
// the row's big number, and the number itself. `installs` counts OTHER people's first installs of
// the skills someone maintains, hence "Installs received"; `installed` is the person's own installs.
type Sort = "installs" | "skills" | "requests" | "watched" | "requested" | "followed" | "curated" | "installed";
const SORTS: { key: Sort; label: string; caption: string; value: (e: Entry) => number }[] = [
  { key: "installs", label: "Installs received", caption: "installs received", value: (e) => e.installs },
  { key: "skills", label: "Skills adopted", caption: "adopted", value: (e) => e.skillCount },
  { key: "requests", label: "Requests fulfilled", caption: "fulfilled", value: (e) => e.requestsFulfilled },
  { key: "watched", label: "Watched", caption: "watched", value: (e) => e.skillsWatched },
  { key: "requested", label: "Requested", caption: "requested", value: (e) => e.skillsRequested },
  { key: "followed", label: "Followed", caption: "followers", value: (e) => e.followers },
  { key: "curated", label: "Curated", caption: "collections", value: (e) => e.collections },
  { key: "installed", label: "Installed", caption: "installed", value: (e) => e.skillsInstalled },
];

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
    <div style={{ maxWidth: 760 }}>
      <ScrollToTop />
      <div className="page-head reveal">
        <div className="eyebrow">Community</div>
        <h1 className="page-title">Leaderboard.</h1>
        {!showHyped && <p className="page-sub">Top contributors by installs received: other people’s first installs of the skills they maintain. Your own installs count under Skills installed.</p>}
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
  // Ranking metric (SORTS above): installs received is the default.
  const [sort, setSort] = useState<Sort>("installs");
  const active = SORTS.find((s) => s.key === sort) ?? SORTS[0]!;
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
        <div className="rows reveal">
          {entries.map((e, i) => {
            const isSelf = !!me?.userId && me.userId === e.userId;
            // Your own row → the catalog's "My Skills" filter; anyone else → the maintained-by view
            // (banner shows their name). Both list only skills the viewer can see (§19/§21).
            const skillsHref = isSelf ? "/catalog?mine=1" : `/catalog?maintainer=${e.userId}&by=${encodeURIComponent(e.displayName)}`;
            // Your own row → the requests page's "Mine" toggle; anyone else → the requested-by view
            // (banner shows their name). Requests have no namespace, so nothing to visibility-filter (§21/§26).
            const requestsHref = isSelf ? "/requests?mine=1" : `/requests?requester=${e.userId}&by=${encodeURIComponent(e.displayName)}`;
            // §38.8 every skill across that person's non-empty collections, own row included.
            const collectionsHref = `/catalog?collectionsBy=${e.userId}&by=${encodeURIComponent(e.displayName)}`;
            return (
            <div className="row lb-row" key={e.userId} style={{ alignItems: "center", gap: 12 }}>
              <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: i < 3 ? "var(--accent-2)" : "var(--faint)", minWidth: 28, textAlign: "right" }}>
                {i + 1}
              </span>
              <UserBubble name={e.displayName} avatar={e.avatar} userId={e.userId} size={34} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.displayName}</div>
                <div className="muted mono" style={{ fontSize: 11.5 }}>
                  {e.skillCount} skill{e.skillCount === 1 ? "" : "s"} adopted
                  {e.requestsFulfilled > 0 && <> · {e.requestsFulfilled} request{e.requestsFulfilled === 1 ? "" : "s"} fulfilled</>}
                  {e.skillsWatched > 0 && <> · {e.skillsWatched} skill{e.skillsWatched === 1 ? "" : "s"} watched</>}
                  {e.skillsRequested > 0 && <> · {e.skillsRequested} skill{e.skillsRequested === 1 ? "" : "s"} requested</>}
                  {e.followers > 0 && <> · {e.followers} follower{e.followers === 1 ? "" : "s"}</>}
                  {e.collections > 0 && <> · {e.collections} collection{e.collections === 1 ? "" : "s"}</>}
                  {e.skillsInstalled > 0 && <> · {e.skillsInstalled} skill{e.skillsInstalled === 1 ? "" : "s"} installed</>}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600 }}>
                  {formatCount(active.value(e))}
                </div>
                <div className="muted mono" style={{ fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                  {active.caption}
                </div>
              </div>
              <div className="lb-actions" style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <Link href={skillsHref} className="btn btn-sm" title={isSelf ? "Your maintained skills" : `Skills maintained by ${e.displayName}`}>Skills</Link>
                <Link href={requestsHref} className="btn btn-sm" title={isSelf ? "Your skill requests" : `Skills requested by ${e.displayName}`}>Requests</Link>
                <Link href={collectionsHref} className="btn btn-sm" title={isSelf ? "Skills in your collections" : `Skills in collections by ${e.displayName}`}>Collections</Link>
                {!isSelf && (
                  <button type="button" className="btn btn-sm" disabled={reaching === e.userId} onClick={() => reachOut(e.userId)} title={`Message ${e.displayName}`}>
                    {reaching === e.userId ? "…" : "Reach out"}
                  </button>
                )}
                {/* §35.4 — right of Reach out; renders nothing on your own row or for the unfollowable. */}
                <FollowButton userId={e.userId} followable={e.followable} name={e.displayName} />
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
