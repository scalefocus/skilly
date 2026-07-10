"use client";
// Topbar messages menu (left of the bell): an unread badge + a dropdown that's a full inline chat
// — a conversation list that opens into a thread with a composer, read & reply without leaving the
// page. Polls like the bell; opening a thread is the read action. SKILLY_SPEC.md §24.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChatBox, type ChatMessage } from "./ChatBox";
import { UserBubble } from "./UserBubble";
import { useDateFmt } from "./DateFormat";
import { useChatPollIntervals } from "./useChatPoll";
import { usePopoverPresence } from "./ui";

interface ConversationSummary { id: string; title: string; href: string | null; unread: number; lastBody: string | null; lastFromName: string | null; lastAt: string | null; peerName: string | null; peerAvatar: string | null; peerUserId: string | null }

// Compact "time ago" for the conversation list, falling back to an absolute date for older threads.
function relativeTime(iso: string | null, absolute: (iso: string | null) => string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d`;
  return absolute(iso);
}
interface ThreadView { id: string; title: string; href: string | null; canPost: boolean; closed: boolean; messages: ChatMessage[]; peerName: string | null; peerAvatar: string | null; peerUserId: string | null; closedHint: string | null }

export function MessagesMenu() {
  const fmt = useDateFmt();
  // Smart-polling cadence (§24): the open thread polls at the floor set[0]; the list walks the set
  // as a backoff, resetting to the floor on activity (new unread) or when the user sends.
  const pollIntervals = useChatPollIntervals();
  const stepRef = useRef(0);            // current index into pollIntervals for the list backoff
  const prevUnreadRef = useRef<number | null>(null); // last seen unread count, to detect increases
  const pollResetRef = useRef<() => void>(() => {});  // jump the list backoff back to the floor
  const [open, setOpen] = useState(false);
  // Keeps the panel mounted through its exit animation (SKILLY_SPEC.md §24, Surfaces).
  const presence = usePopoverPresence(open);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [unread, setUnread] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [active, setActive] = useState<ThreadView | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Guards the ?conversation=<id> email deep link so it opens that thread exactly once (§24).
  const deepLinkHandled = useRef(false);

  // Refresh page 0 (the freshest 100) + the unread badge. If the user has scrolled and loaded
  // older pages, don't clobber that list on a poll — just keep the badge current.
  const PAGE = 100;
  // Fetch page 0 + the unread badge. Returns true when there's NEW activity (the unread count rose
  // since the previous fetch) — the backoff loop uses that to drop back to the floor interval.
  const fetchList = useCallback(async (): Promise<boolean> => {
    if (typeof document !== "undefined" && document.hidden) return false;
    try {
      const r = await fetch("/api/messages");
      if (!r.ok) return false;
      const j = await r.json();
      if (!j) return false;
      const u = Number(j.unreadConversations ?? 0);
      setUnread(u);
      setConversations((prev) => (prev.length > PAGE ? prev : (j.conversations ?? [])));
      setHasMore((cur) => (conversations.length > PAGE ? cur : Boolean(j.hasMore)));
      const prev = prevUnreadRef.current;
      prevUnreadRef.current = u;
      return prev !== null && u > prev; // first load (prev === null) is not "activity"
    } catch {
      return false;
    }
  }, [conversations.length]);
  // Fire-and-forget refresh for the manual callers (bell open, send, deep-link). Backoff is driven
  // separately by the scheduled loop below.
  const refreshList = useCallback(() => { void fetchList(); }, [fetchList]);

  // Infinite scroll: append the next page of older conversations.
  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    fetch(`/api/messages?offset=${conversations.length}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j) {
          setConversations((prev) => [...prev, ...(j.conversations ?? [])]);
          setHasMore(Boolean(j.hasMore));
          setUnread(Number(j.unreadConversations ?? 0));
        }
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [conversations.length, hasMore, loadingMore]);

  // Smart-polling backoff for the list + unread badge (§24): start at the floor, advance one step
  // up the set per quiet poll (clamped at the last value), and snap back to the floor whenever the
  // unread count rises. Hidden tab: freeze (no fetch, step held); on return, refresh once and resume
  // at the same step (a genuine new-unread on that refresh still resets via the activity rule).
  useEffect(() => {
    const intervals = pollIntervals.length ? pollIntervals : [7];
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const schedule = () => {
      if (!live) return;
      const secs = intervals[Math.min(stepRef.current, intervals.length - 1)] ?? 7;
      timer = setTimeout(tick, secs * 1000);
    };
    const tick = async () => {
      if (!live) return;
      if (typeof document !== "undefined" && document.hidden) { schedule(); return; } // frozen: hold step
      const activity = await fetchList();
      if (!live) return;
      stepRef.current = activity ? 0 : Math.min(stepRef.current + 1, intervals.length - 1);
      schedule();
    };
    // Let send() (and any future activity) drop the cadence back to the floor and re-poll promptly.
    pollResetRef.current = () => { stepRef.current = 0; clear(); schedule(); };

    stepRef.current = 0;
    void fetchList();
    schedule();

    const onVis = () => { if (!document.hidden) void fetchList(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      live = false;
      clear();
      document.removeEventListener("visibilitychange", onVis);
      pollResetRef.current = () => {};
    };
  }, [pollIntervals, fetchList]);

  // Infinite scroll: load older conversations when the sentinel nears the bottom of the list.
  // Root is the scroll container (the dropdown's list), not the viewport.
  useEffect(() => {
    if (!open || active || !hasMore) return;
    const root = listScrollRef.current;
    const el = sentinelRef.current;
    if (!root || !el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    }, { root, rootMargin: "120px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [open, active, hasMore, loadMore]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const openThread = useCallback(async (id: string) => {
    setLoadingThread(true);
    try {
      const r = await fetch(`/api/messages/${id}`);
      if (r.ok) {
        setActive(await r.json());
        // Opening the thread is the read action.
        fetch(`/api/messages/${id}/read`, { method: "POST" }).then(() => {
          setConversations((cs) => cs.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
          setUnread((u) => Math.max(0, u - (conversations.find((c) => c.id === id)?.unread ? 1 : 0)));
        }).catch(() => {});
      }
    } finally { setLoadingThread(false); }
  }, [conversations]);

  // Open a specific conversation on demand (e.g. "Reach out" on a maintainer card dispatches
  // `skilly:open-conversation`).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (!id) return;
      setOpen(true);
      void openThread(id);
      refreshList();
    };
    window.addEventListener("skilly:open-conversation", onOpen as EventListener);
    return () => window.removeEventListener("skilly:open-conversation", onOpen as EventListener);
  }, [openThread, refreshList]);

  // Email deep link (§24): a `?conversation=<id>` on any page opens that thread in this panel and
  // then strips the param, so a refresh or a shared URL doesn't reopen it. Runs once (ref-guarded)
  // — a direct message has no page of its own, so this is how its notification email links back.
  useEffect(() => {
    if (deepLinkHandled.current || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("conversation");
    if (!id) return;
    deepLinkHandled.current = true;
    params.delete("conversation");
    const qs = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
    setOpen(true);
    void openThread(id);
    refreshList();
  }, [openThread, refreshList]);

  // Poll the open thread at the floor interval set[0] for near-live replies (§24).
  useEffect(() => {
    if (!open || !active) return;
    const secs = pollIntervals[0] ?? 7;
    const id = setInterval(() => {
      if (document.hidden) return;
      fetch(`/api/messages/${active.id}`).then((r) => (r.ok ? r.json() : null)).then((j) => j && setActive(j)).catch(() => {});
    }, secs * 1000);
    return () => clearInterval(id);
  }, [open, active, pollIntervals]);

  const send = async (body: string) => {
    if (!active) return;
    const r = await fetch(`/api/messages/${active.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) });
    if (r.ok) {
      const { message } = await r.json();
      setActive((a) => (a ? { ...a, messages: [...a.messages, message] } : a));
      refreshList();
      pollResetRef.current(); // sending is activity — drop the list backoff back to the floor
    }
  };

  return (
    <div ref={rootRef} className="msg-menu">
      <button
        type="button"
        className="bell"
        aria-label={`Messages${unread ? ` (${unread} unread)` : ""}`}
        aria-expanded={open}
        onClick={() => { setOpen((o) => !o); if (!open) { refreshList(); pollResetRef.current(); } }}
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 9 9 0 0 1-3.9-.9L3 21l1.9-5.6a8.38 8.38 0 0 1-.9-3.9A8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
        </svg>
        {unread > 0 && <span className="bell-dot" aria-hidden>{unread > 9 ? "9+" : unread}</span>}
      </button>

      {presence && (
        <>
        {/* Mobile-only dimmed backdrop behind the full-screen panel. */}
        <div className={`msg-backdrop menu-pop${presence === "closing" ? " menu-pop-closing" : ""}`} aria-hidden onClick={() => setOpen(false)} />
        <div role="dialog" aria-label="Messages" className={`msg-panel menu-pop${presence === "closing" ? " menu-pop-closing" : ""}`}>
          {!active ? (
            <>
              <div className="msg-panel-head">
                <strong style={{ fontSize: 14 }}>Messages</strong>
                <span className="muted mono" style={{ fontSize: 11, marginLeft: "auto" }}>{unread ? `${unread} unread` : "all read"}</span>
                <button type="button" className="msg-close" aria-label="Close messages" onClick={() => setOpen(false)}>✕</button>
              </div>
              <div ref={listScrollRef} className="msg-scroll" style={{ maxHeight: 380, overflowY: "auto" }}>
                {conversations.length === 0 ? (
                  <p className="muted" style={{ fontSize: 13, padding: "16px 14px", margin: 0 }}>No conversations yet. Discussions you join during reviews show up here.</p>
                ) : (
                  conversations.map((c) => (
                    <button key={c.id} type="button" onClick={() => void openThread(c.id)} className="user-menu-item" style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "stretch", gap: 3, padding: "10px 14px", borderBottom: "1px solid var(--line)", textAlign: "left" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {c.unread > 0 && <span aria-hidden className="glow-accent" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }} />}
                        {/* Direct message: the other person's avatar bubble (photo or initial). */}
                        {c.peerName && <UserBubble name={c.peerName} avatar={c.peerAvatar} userId={c.peerUserId} size={22} />}
                        <span style={{ flex: 1, fontWeight: c.unread ? 700 : 500, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
                        {c.lastAt && <time dateTime={c.lastAt} title={fmt.dateTime(c.lastAt)} className="muted mono" style={{ fontSize: 10.5, flexShrink: 0 }}>{relativeTime(c.lastAt, fmt.date)}</time>}
                      </span>
                      {c.lastBody && <span className="muted" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.lastFromName}: {c.lastBody}</span>}
                    </button>
                  ))
                )}
                {hasMore && (
                  <div ref={sentinelRef} style={{ padding: "12px 0", textAlign: "center" }} aria-hidden>
                    <span className="muted mono" style={{ fontSize: 11 }}>{loadingMore ? "loading more…" : "·"}</span>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="msg-panel-head">
                <button type="button" className="btn-ghost" aria-label="Back to conversations" onClick={() => setActive(null)} style={{ fontSize: 14, padding: "2px 6px" }}>←</button>
                {active.peerName ? (
                  // Direct message: show who you're talking to — avatar bubble + name.
                  <span style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                    <UserBubble name={active.peerName} avatar={active.peerAvatar} userId={active.peerUserId} size={24} />
                    <strong style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{active.peerName}</strong>
                  </span>
                ) : (
                  <strong style={{ fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{active.title}</strong>
                )}
                {active.href && <Link href={active.href} className="btn-ghost mono" style={{ fontSize: 11 }} onClick={() => setOpen(false)}>open →</Link>}
                <button type="button" className="msg-close" aria-label="Close messages" onClick={() => setOpen(false)}>✕</button>
              </div>
              <div className="msg-scroll" style={{ padding: "12px 14px" }}>
                {loadingThread ? <p className="muted" style={{ fontSize: 13 }}>Loading…</p> : <ChatBox messages={active.messages} canPost={active.canPost} closed={active.closed} onSend={send} listHeight={300} closedHint={active.closedHint ?? undefined} />}
              </div>
            </>
          )}
        </div>
        </>
      )}
    </div>
  );
}
