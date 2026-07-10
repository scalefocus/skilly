"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { EmptyState, LoadMoreSentinel, Pill, ScrollToTop } from "../../components/ui";
import { useDateFmt } from "../../components/DateFormat";
import { NOTIFICATION_LABELS } from "@skilly/shared/notifications";

const PAGE = 100;

interface NotificationView {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
  skillTitle: string | null;
  skillSlug: string | null;
  namespaceSlug: string | null;
}

// Per-type pill text + tone come from the shared map (§12) — the SAME source the email subject
// title uses, so the inbox pill and the email subject line stay in lockstep.

export default function NotificationsPage() {
  const fmt = useDateFmt();
  // Infinite scroll: newest-first pages of 100, accumulated.
  const [items, setItems] = useState<NotificationView[]>([]);
  const [unread, setUnread] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Multi-select event-type filter — server-side (the list paginates). Empty set = all.
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const toggleType = (t: string) =>
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  const typesQs = [...typeFilter].sort().join(",");

  const loadPage = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/notifications?offset=${offset}${typesQs ? `&types=${encodeURIComponent(typesQs)}` : ""}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Request failed (${r.status})`);
      const j = (await r.json()) as { items: NotificationView[]; unread: number };
      setItems((prev) => (offset === 0 ? j.items : [...prev, ...j.items]));
      setUnread(j.unread);
      setHasMore(j.items.length === PAGE);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, [typesQs]);

  // Initial load + reset to page 0 whenever the type filter changes.
  useEffect(() => {
    setItems([]);
    setHasMore(true);
    void loadPage(0);
  }, [loadPage]);

  // Opening the inbox IS the read action (§12) — no buttons. Once the first page arrives with
  // unread items, mark everything read server-side, but do NOT reload: the fetched readAt
  // values keep the "new" highlight on screen for this visit so the user can see what was
  // unread. The bell badge clears immediately via the event AppShell listens for.
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current || loading || unread === 0) return;
    marked.current = true;
    fetch("/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    })
      .then((r) => {
        if (r.ok) window.dispatchEvent(new Event("skilly:notifications-read"));
        else marked.current = false; // retry on next load
      })
      .catch(() => {
        marked.current = false;
      });
  }, [loading, unread]);

  if (error && items.length === 0) return <EmptyState icon="⚠" title="Couldn’t load notifications" hint={error} />;

  return (
    <div className="reveal" style={{ maxWidth: 760 }}>
      <ScrollToTop />
      <div className="page-head">
        <div className="eyebrow">Inbox</div>
        <h1 className="page-title">Notifications.</h1>
        <p className="page-sub">Outcomes of your proposals and reviews — opening this page marks them read. Delivery by email/webhook is configured by your operator.</p>
      </div>

      {/* Multi-select event-type toggles: pick any combination, or clear to see everything. */}
      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap", alignItems: "center" }}>
        {Object.entries(NOTIFICATION_LABELS).map(([type, meta]) => (
          <button
            key={type}
            type="button"
            className={`facet${typeFilter.has(type) ? " facet-on" : ""}`}
            aria-pressed={typeFilter.has(type)}
            onClick={() => toggleType(type)}
          >
            {meta.title}
          </button>
        ))}
        {typeFilter.size > 0 && (
          <button className="btn-ghost mono" style={{ fontSize: 12 }} onClick={() => setTypeFilter(new Set())}>
            ✕ clear
          </button>
        )}
      </div>

      {loading && items.length === 0 ? (
        <div className="skeleton" style={{ height: 180, borderRadius: "var(--radius)" }} />
      ) : items.length === 0 ? (
        typeFilter.size > 0
          ? <EmptyState title="No notifications of the selected types" hint="Toggle the filters above or clear the selection." />
          : <EmptyState title="You’re all caught up" hint="Proposal decisions will show up here." />
      ) : (
        <div className="rows">
          {items.map((n) => {
            const meta = NOTIFICATION_LABELS[n.type] ?? { title: n.type, tone: "muted" as const };
            const proposalId = typeof n.payload.proposalId === "string" ? n.payload.proposalId : null;
            const requestId = typeof n.payload.requestId === "string" ? n.payload.requestId : null;
            const note = typeof n.payload.note === "string" ? n.payload.note : null;
            // Prefer the resolved slugs (accurate namespace, even for brand-new skills);
            // fall back to whatever the payload carried.
            const nsSlug = n.namespaceSlug ?? (typeof n.payload.namespaceSlug === "string" ? n.payload.namespaceSlug : null);
            const skSlug = n.skillSlug ?? (typeof n.payload.skillSlug === "string" ? n.payload.skillSlug : null);
            const skillHref = nsSlug && skSlug ? `/skills/${nsSlug}/${skSlug}` : null;
            const skillName = n.skillTitle ?? skSlug;
            const semver = typeof n.payload.semver === "string" ? n.payload.semver : null;
            const isSystemLog = n.type === "system.error";
            const eventCount = typeof n.payload.count === "number" ? n.payload.count : null;
            return (
              <div className="row" key={n.id} style={{ alignItems: "flex-start", gap: 12, opacity: n.readAt ? 0.62 : 1 }}>
                {!n.readAt && <span aria-hidden className="glow-accent" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", marginTop: 7, flexShrink: 0 }} />}
                <div className="grow" style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <Pill tone={meta.tone}>{meta.title}</Pill>
                    {skillName && (
                      <span style={{ fontSize: 14, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {skillName}
                        {semver && <span className="muted mono" style={{ fontWeight: 400, fontSize: 11.5 }}> v{semver}</span>}
                      </span>
                    )}
                    {isSystemLog && eventCount != null && (
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{eventCount} new event{eventCount === 1 ? "" : "s"}</span>
                    )}
                    <span className="muted mono" style={{ fontSize: 11, marginLeft: "auto" }}>{fmt.dateTime(n.createdAt)}</span>
                  </div>
                  {note && <p className="muted" style={{ fontSize: 13.5, margin: "8px 0 0" }}>“{note}”</p>}
                  {proposalId && (
                    <Link href={`/proposals/${proposalId}`} className="btn-ghost mono" style={{ fontSize: 12, marginTop: 6, display: "inline-block" }}>
                      view proposal →
                    </Link>
                  )}
                  {requestId && (
                    <Link href={`/requests/${requestId}`} className="btn-ghost mono" style={{ fontSize: 12, marginTop: 6, display: "inline-block" }}>
                      view request →
                    </Link>
                  )}
                  {skillHref && (
                    <Link href={skillHref} className="btn-ghost mono" style={{ fontSize: 12, marginTop: 6, display: "inline-block", marginLeft: proposalId || requestId ? 12 : 0 }}>
                      view skill →
                    </Link>
                  )}
                  {isSystemLog && (
                    <Link href="/system-log" className="btn-ghost mono" style={{ fontSize: 12, marginTop: 6, display: "inline-block" }}>
                      view system log →
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <LoadMoreSentinel hasMore={hasMore && items.length > 0} loading={loading} onLoadMore={() => void loadPage(items.length)} />
    </div>
  );
}
