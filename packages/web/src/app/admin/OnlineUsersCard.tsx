"use client";
// The "Currently online" presence card (SKILLY_SPEC.md §4). Lived on the Administration page until
// v2.7.0; now the first section of the Monitoring page (/admin/rum, §32.7), still a collapsible card
// through the shared Administration mechanism (§5) under its original `online` card id, so an
// admin's remembered open/closed choice survives the move.
//
// Presence is activity-window based (last_seen within the selected window, default 5 min); the card
// bundles the active-users trend chart (own range), DAU/WAU/MAU, the window toggle, and a searchable
// infinite-scroll list with "Reach out". It keeps its own 60s visibility-aware poll even though the
// rest of the Monitoring page fetches on mount/range-change only (§4).
import { useCallback, useEffect, useState } from "react";
import nextDynamic from "next/dynamic";
import { LoadMoreSentinel } from "../../components/ui";
import { UserBubble } from "../../components/UserBubble";
import { readPref, writePref, PREF_DAU_RANGE, PREF_ONLINE_WINDOW } from "../../lib/prefs";
import { CollapsibleCard } from "./CollapsibleCard";

// recharts is heavy (d3) — code-split it out of the route's initial bundle.
const ActiveUsersChart = nextDynamic(() => import("./ActiveUsersChart").then((m) => m.ActiveUsersChart), {
  ssr: false,
  loading: () => <div className="skeleton" style={{ height: 180, borderRadius: "var(--radius)" }} />,
});

type DauRange = 7 | 30 | 90 | "all";
const DAU_RANGES: { key: DauRange; label: string }[] = [
  { key: 7, label: "7d" },
  { key: 30, label: "30d" },
  { key: 90, label: "90d" },
  { key: "all", label: "All" },
];
const toDauRange = (s: string): DauRange => (s === "all" ? "all" : s === "7" ? 7 : s === "90" ? 90 : 30);

// "Online" window choices (§4) — must mirror ONLINE_WINDOW_OPTIONS server-side; anything else the
// server falls back to 5. `long` is for the card's descriptive sentence.
const ONLINE_WINDOWS: { mins: number; label: string; long: string }[] = [
  { mins: 5, label: "5m", long: "5 minutes" },
  { mins: 60, label: "1h", long: "hour" },
  { mins: 480, label: "8h", long: "8 hours" },
  { mins: 1440, label: "24h", long: "24 hours" },
  { mins: 43200, label: "30d", long: "30 days" },
];
const toOnlineWindow = (s: string): number => (ONLINE_WINDOWS.some((w) => w.mins === Number(s)) ? Number(s) : 5);

interface OnlineUser { userId: string; displayName: string; email: string; avatar: string | null; lastSeen: string; lastSeenPage: string | null }
const ONLINE_PAGE = 100;

/** Everyone shown is active within the selected window, which can now reach 24h — so up to hours. */
function activeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 15) return "active just now";
  if (s < 60) return `active ${s}s ago`;
  if (s < 3600) return `active ${Math.floor(s / 60)}m ago`;
  return `active ${Math.floor(s / 3600)}h ago`;
}

// Reuses the maintainer card. Search + infinite scroll, plus a 60s visibility-aware poll that always refreshes the count but only refreshes the list when it's
// safe (no active search and the list hasn't been scrolled past page 1) so it never yanks the view.
export function OnlineUsersCard({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [users, setUsers] = useState<OnlineUser[] | null>(null);
  const [total, setTotal] = useState(0);
  // Rolling-window activity counts (§4) — piggyback on this card's existing poll (see below).
  const [active, setActive] = useState<{ dau: number; wau: number; mau: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");
  const [me, setMe] = useState<{ userId: string | null; devAuth?: boolean } | null>(null);
  const [reaching, setReaching] = useState<string | null>(null);
  // Daily-active-users trend chart (§4) — its own range, remembered across visits like every
  // other chart window in the app. Changes at most once a day (the worker snapshot), so it's
  // fetched on mount/range-change only — no polling needed.
  const [dauRange, setDauRange] = useState<DauRange>(() => toDauRange(readPref(PREF_DAU_RANGE, "30")));
  const pickDauRange = (r: DauRange) => { setDauRange(r); writePref(PREF_DAU_RANGE, String(r)); };
  const [dauSeries, setDauSeries] = useState<{ bucket: "day" | "week" | "month"; points: { date: string; count: number }[] } | null>(null);
  // "Online" window (§4) — a per-admin view preference, remembered like the chart ranges.
  const [winMins, setWinMins] = useState<number>(() => toOnlineWindow(readPref(PREF_ONLINE_WINDOW, "5")));
  const pickWindow = (m: number) => { setWinMins(m); writePref(PREF_ONLINE_WINDOW, String(m)); };

  useEffect(() => { fetch("/api/me").then((r) => (r.ok ? r.json() : null)).then((j) => setMe(j)).catch(() => {}); }, []);
  useEffect(() => { const t = setTimeout(() => setQDeb(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    let live = true;
    setDauSeries(null);
    fetch(`/api/admin/users/active-series?range=${dauRange}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { bucket: "day" | "week" | "month"; points: { date: string; count: number }[] } | null) => { if (live && j) setDauSeries(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [dauRange]);

  const qs = useCallback((offset: number) => {
    const p = new URLSearchParams({ offset: String(offset), limit: String(ONLINE_PAGE), window: String(winMins) });
    if (qDeb) p.set("q", qDeb);
    return p.toString();
  }, [qDeb, winMins]);

  // (Re)load page 0 whenever the search or the online window changes.
  useEffect(() => {
    let live = true;
    setLoading(true);
    fetch(`/api/admin/users/online?${qs(0)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { users: OnlineUser[]; total: number; dau: number; wau: number; mau: number } | null) => {
        if (live && j) { setUsers(j.users); setTotal(j.total); setActive({ dau: j.dau, wau: j.wau, mau: j.mau }); }
      })
      .catch(() => {})
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [qs]);

  const loadMore = useCallback(async () => {
    if (!users) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/admin/users/online?${qs(users.length)}`);
      if (!r.ok) return;
      const j = (await r.json()) as { users: OnlineUser[]; total: number; dau: number; wau: number; mau: number };
      setUsers((prev) => (prev ? [...prev, ...j.users] : j.users));
      setTotal(j.total);
      setActive({ dau: j.dau, wau: j.wau, mau: j.mau });
    } finally { setLoading(false); }
  }, [users, qs]);

  // 60s poll: counts always; list only when safe (no search, not scrolled past page 1).
  useEffect(() => {
    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const r = await fetch(`/api/admin/users/online?${qs(0)}`);
        if (!r.ok) return;
        const j = (await r.json()) as { users: OnlineUser[]; total: number; dau: number; wau: number; mau: number };
        setTotal(j.total);
        setActive({ dau: j.dau, wau: j.wau, mau: j.mau });
        setUsers((prev) => (!qDeb && (prev?.length ?? 0) <= ONLINE_PAGE ? j.users : prev));
      } catch { /* best-effort refresh */ }
    };
    const id = setInterval(tick, 60000);
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [qs, qDeb]);

  // "Reach out": open (or reuse) a 1:1 direct conversation in the messages menu.
  const reachOut = async (userId: string) => {
    setReaching(userId);
    try {
      const r = await fetch("/api/messages/direct", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
      if (r.ok) {
        const { conversationId } = await r.json();
        window.dispatchEvent(new CustomEvent("skilly:open-conversation", { detail: { id: conversationId } }));
      }
    } finally { setReaching(null); }
  };

  return (
    <CollapsibleCard
      cardId="online"
      title="Currently online"
      summary={`${total} ${total === 1 ? "user" : "users"}`}
      open={open}
      onToggle={onToggle}
    >
      {/* Active-users trend (§4): one point per day, snapshotted once daily by the worker — a
          history, unlike the live rolling counts below. Bucketing is span-adaptive (server-side,
          §21 thresholds): 7d/30d/90d plot raw daily points, All steps up to weekly/monthly only
          once the collected history is long enough to need it — so a fresh deployment shows a
          short, growing daily line rather than one coarse bucket (no back-filled data either). */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <span className="muted mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em" }}>Active users</span>
        <div className="sort-toggle" role="group" aria-label="Chart range">
          {DAU_RANGES.map((r) => (
            <button key={String(r.key)} type="button" className={`sort-opt${dauRange === r.key ? " sort-on" : ""}`} onClick={() => pickDauRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {dauSeries === null ? (
        <div className="skeleton" style={{ height: 180, borderRadius: "var(--radius)", marginBottom: 16 }} />
      ) : dauSeries.points.length === 0 ? (
        <div className="muted" style={{ fontSize: 13, marginBottom: 16 }}>No history yet — the daily snapshot job hasn't run.</div>
      ) : (
        <div style={{ marginBottom: 16 }}>
          <ActiveUsersChart points={dauSeries.points} bucket={dauSeries.bucket} />
        </div>
      )}

      {/* Rolling-window activity (§4) — live counts off the same last_seen signal as the list
          below, not a historical trend: this is "how many right now", not "how many on a past
          date". Each window is a distinct-user count over the trailing period, refreshed on the
          same 60s poll as the online list (no separate fetch). */}
      <div style={{ display: "flex", gap: 20, marginBottom: 16, paddingBottom: 14, borderBottom: "1px solid var(--line)" }}>
        {([
          ["DAU", "last 24h", active?.dau],
          ["WAU", "last 7d", active?.wau],
          ["MAU", "last 30d", active?.mau],
        ] as const).map(([label, caption, n]) => (
          <div key={label}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 1 }}>
              {n == null ? <span className="skeleton" style={{ display: "inline-block", width: 30, height: 22, borderRadius: 4 }} /> : n}
            </div>
            <div className="muted mono" style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 4 }}>
              {label} <span style={{ opacity: 0.7 }}>· {caption}</span>
            </div>
          </div>
        ))}
      </div>

      {/* "Online" window (§4): sits just above the search box, right-aligned in a header row that
          mirrors the trend chart's range toggle above — the caption is the row's left-hand label;
          same toggle vocabulary as the chart ranges; per-admin, remembered. */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 13.5 }}>
          Users active within the last {ONLINE_WINDOWS.find((w) => w.mins === winMins)?.long ?? "5 minutes"}. Reach out to start a direct message.
        </span>
        <div className="sort-toggle" role="group" aria-label="Online window">
          {ONLINE_WINDOWS.map((w) => (
            <button key={w.mins} type="button" className={`sort-opt${winMins === w.mins ? " sort-on" : ""}`} onClick={() => pickWindow(w.mins)}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <input
        className="input" style={{ width: "100%", marginBottom: 14 }}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search online users by name or email…"
        aria-label="Search online users"
      />

      {users === null ? (
        <div className="skeleton" style={{ height: 120, borderRadius: "var(--radius)" }} />
      ) : users.length === 0 ? (
        <div className="muted" style={{ fontSize: 13.5 }}>{qDeb ? "No online users match your search." : "No one is online right now."}</div>
      ) : (
        <div className="rows">
          {users.map((u) => (
            <div className="maintainer-item has-page" key={u.userId}>
              <div className="m-av"><UserBubble name={u.displayName} avatar={u.avatar} userId={u.userId} /></div>
              <div className="m-name">
                <div className="ttl">{u.displayName}</div>
                <div className="sub mono" style={{ fontSize: 11 }}>{u.email}</div>
              </div>
              <div className="m-page" title={u.lastSeenPage ?? undefined}>{u.lastSeenPage ?? "—"}</div>
              <div className="m-meta">
                <span className="chip">{activeAgo(u.lastSeen)}</span>
                {/* Hidden on your own card — except under dev sign-in (solo-dev testing). */}
                {me?.userId && (u.userId !== me.userId || me.devAuth) && (
                  <button className="btn btn-sm" disabled={reaching === u.userId} onClick={() => reachOut(u.userId)} title={`Message ${u.displayName}`}>
                    {reaching === u.userId ? "…" : "Reach out"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <LoadMoreSentinel hasMore={(users?.length ?? 0) < total} loading={loading} onLoadMore={() => void loadMore()} />
    </CollapsibleCard>
  );
}
