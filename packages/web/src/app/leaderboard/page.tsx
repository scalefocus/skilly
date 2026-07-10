"use client";
import { useState } from "react";
import Link from "next/link";
import { useApi, EmptyState, ScrollToTop, formatCount } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { UserBubble } from "../../components/UserBubble";

interface Entry {
  userId: string;
  displayName: string;
  email: string;
  avatar: string | null;
  skillCount: number;
  installs: number;
  requestsFulfilled: number;
  skillsWatched: number;
}

function Leaderboard() {
  const [window, setWindow] = useState<"all" | "30d">("all");
  // Ranking metric (§26): installs credited (default) / skills proposed / skill requests fulfilled / skills watched.
  const [sort, setSort] = useState<"installs" | "skills" | "requests" | "watched">("installs");
  const { data, loading, error } = useApi<{ entries: Entry[] }>(`/api/leaderboard?window=${window}&sort=${sort}`);
  // Current user's id → identify your own row (hide "Reach out" on it; link "Skills" to My Skills).
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
    <div style={{ maxWidth: 760 }}>
      <ScrollToTop />
      <div className="page-head reveal">
        <div className="eyebrow">Community</div>
        <h1 className="page-title">Leaderboard.</h1>
        <p className="page-sub">Top contributors by total installs of the skills they’ve proposed.</p>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <div className="sort-toggle" role="group" aria-label="Rank by">
          <button type="button" className={`sort-opt${sort === "installs" ? " sort-on" : ""}`} onClick={() => setSort("installs")}>Installs</button>
          <button type="button" className={`sort-opt${sort === "skills" ? " sort-on" : ""}`} onClick={() => setSort("skills")}>Skills proposed</button>
          <button type="button" className={`sort-opt${sort === "requests" ? " sort-on" : ""}`} onClick={() => setSort("requests")}>Requests fulfilled</button>
          <button type="button" className={`sort-opt${sort === "watched" ? " sort-on" : ""}`} onClick={() => setSort("watched")}>Watched</button>
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
            return (
            <div className="row lb-row" key={e.userId} style={{ alignItems: "center", gap: 12 }}>
              <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: i < 3 ? "var(--accent-2)" : "var(--faint)", minWidth: 28, textAlign: "right" }}>
                {i + 1}
              </span>
              <UserBubble name={e.displayName} avatar={e.avatar} userId={e.userId} size={34} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.displayName}</div>
                <div className="muted mono" style={{ fontSize: 11.5 }}>
                  {e.skillCount} skill{e.skillCount === 1 ? "" : "s"} proposed
                  {e.requestsFulfilled > 0 && <> · {e.requestsFulfilled} request{e.requestsFulfilled === 1 ? "" : "s"} fulfilled</>}
                  {e.skillsWatched > 0 && <> · {e.skillsWatched} skill{e.skillsWatched === 1 ? "" : "s"} watched</>}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600 }}>
                  {formatCount(sort === "requests" ? e.requestsFulfilled : sort === "skills" ? e.skillCount : sort === "watched" ? e.skillsWatched : e.installs)}
                </div>
                <div className="muted mono" style={{ fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                  {sort === "requests" ? "fulfilled" : sort === "skills" ? "skills" : sort === "watched" ? "watched" : "installs"}
                </div>
              </div>
              <div className="lb-actions" style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <Link href={skillsHref} className="btn btn-sm" title={isSelf ? "Your maintained skills" : `Skills maintained by ${e.displayName}`}>Skills</Link>
                {!isSelf && (
                  <button type="button" className="btn btn-sm" disabled={reaching === e.userId} onClick={() => reachOut(e.userId)} title={`Message ${e.displayName}`}>
                    {reaching === e.userId ? "…" : "Reach out"}
                  </button>
                )}
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
      <Leaderboard />
    </RequireAuth>
  );
}
