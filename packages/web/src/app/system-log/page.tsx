"use client";
// System log (SKILLY_SPEC.md §25) — platform-admin-only view of user-facing HTTP error events
// (5XX + meaningful 4XX) the web tier returned, with the user who hit them. Infinite scroll in
// pages of 100, trigram substring search, and status-class chips. Mirrors the /audit + /notifications
// list patterns. A namespace admin who navigates here directly sees a graceful "platform admins
// only" state (the API 403s).
import { useCallback, useEffect, useRef, useState } from "react";
import { downloadFile, EmptyState, LoadMoreSentinel, Pill, ScrollToTop, useApi } from "../../components/ui";
import { useDateFmt } from "../../components/DateFormat";
import { DateRangeFilter, dayStartIso, dayEndIso } from "../../components/DateRangeFilter";

const PAGE = 100;

interface SystemEventView {
  id: string;
  createdAt: string;
  status: number;
  method: string;
  route: string;
  path: string;
  userId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  errorCode: string | null;
  message: string | null;
  requestId: string | null;
  durationMs: number | null;
  source: string;
}

const STATUS_CHIPS = [
  { label: "All", value: "" },
  { label: "5XX", value: "5xx" },
  { label: "403", value: "403" },
  { label: "422", value: "422" },
  { label: "429", value: "429" },
];

function toneFor(status: number): "ok" | "warn" | "danger" | "muted" {
  if (status >= 500) return "danger";
  if (status === 403 || status === 429) return "warn";
  return "muted";
}

// Compact "time ago", falling back to an absolute date for older events.
function relativeTime(iso: string, absolute: (iso: string) => string): string {
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

export default function SystemLogPage() {
  const fmt = useDateFmt();
  // Admin gate (the API also hard-enforces it): show a graceful state to non-admins.
  const { data: me, loading: meLoading } = useApi<{ isPlatformAdmin?: boolean }>("/api/me");

  const [status, setStatus] = useState("");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState(""); // debounced
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const filtersActive = !!status || !!q || !!from || !!to;
  const clearFilters = () => { setStatus(""); setQInput(""); setQ(""); setFrom(""); setTo(""); };
  const [items, setItems] = useState<SystemEventView[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Debounce the search box so each keystroke doesn't fire a query.
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const loadPage = useCallback(
    async (offset: number, reset: boolean) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
        if (status) qs.set("status", status);
        if (q) qs.set("q", q);
        if (from) qs.set("from", dayStartIso(from));
        if (to) qs.set("to", dayEndIso(to));
        const r = await fetch(`/api/system-log?${qs}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Request failed (${r.status})`);
        const j = (await r.json()) as { items: SystemEventView[] };
        setItems((prev) => (reset ? j.items : [...prev, ...j.items]));
        setHasMore(j.items.length === PAGE);
        setError(null);
      } catch (e) {
        setError(String((e as Error).message ?? e));
      } finally {
        setLoading(false);
      }
    },
    [status, q, from, to],
  );

  // Reset to page 0 whenever the filter or search changes.
  useEffect(() => {
    setItems([]);
    setHasMore(true);
    void loadPage(0, true);
  }, [loadPage]);

  // Export honors the SAME active filters as the on-screen list (status/search/date range).
  const exportCsv = async () => {
    setExportBusy(true); setExportMsg(null);
    try {
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (q) qs.set("q", q);
      if (from) qs.set("from", dayStartIso(from));
      if (to) qs.set("to", dayEndIso(to));
      const { total, exported } = await downloadFile(`/api/system-log/export?${qs}`);
      if (total > exported) {
        setExportMsg({ kind: "ok", text: `Exported the most recent ${exported.toLocaleString()} of ${total.toLocaleString()} matching entries — narrow the date range to get the rest.` });
      }
    } catch (e) {
      setExportMsg({ kind: "err", text: String((e as Error).message) });
    } finally {
      setExportBusy(false);
    }
  };

  if (!meLoading && me && !me.isPlatformAdmin) {
    return <EmptyState icon="🔒" title="Platform admins only" hint="The system log is restricted to platform administrators." />;
  }
  if (error && items.length === 0) {
    const denied = /admin|unauthenticated/i.test(error);
    return <EmptyState icon={denied ? "🔒" : "⚠"} title={denied ? "Platform admins only" : "Couldn’t load the system log"} hint={error} />;
  }

  return (
    <div style={{ maxWidth: 980 }}>
      <div className="page-head reveal">
        <div className="eyebrow">Governance</div>
        <h1 className="page-title">System log.</h1>
        <p className="page-sub">Errors the platform returned to users — server faults (5XX) and the meaningful client errors (403/409/422/429), with who hit them. Platform admins only.</p>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap", alignItems: "center" }}>
        {STATUS_CHIPS.map((c) => (
          <button key={c.value} className={`btn btn-sm${status === c.value ? " btn-primary" : ""}`} onClick={() => setStatus(c.value)}>
            {c.label}
          </button>
        ))}
        <DateRangeFilter from={from} to={to} onChange={({ from: f, to: t }) => { setFrom(f); setTo(t); }} />
        {filtersActive && (
          <button className="btn-ghost mono" style={{ fontSize: 12 }} onClick={clearFilters}>✕ clear filters</button>
        )}
        <button
          className="btn btn-sm"
          onClick={exportCsv}
          disabled={exportBusy}
          title="Download the currently filtered entries as a CSV file (capped at 50,000 rows)"
        >
          {exportBusy ? "Exporting…" : "↓ Export CSV"}
        </button>
        <span style={{ flex: 1 }} />
        <div className="search" style={{ maxWidth: 360, minWidth: 240 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Search route, error, message, or user…"
            aria-label="Search system events"
          />
        </div>
      </div>

      {exportMsg && (
        <div className="card card-pad" style={{ marginBottom: 16, fontSize: 13.5, color: exportMsg.kind === "err" ? "var(--danger)" : "var(--ok)" }}>
          {exportMsg.text}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="skeleton" style={{ height: 260, borderRadius: "var(--radius)" }} />
      ) : items.length === 0 ? (
        <EmptyState title={filtersActive ? "No matching events" : "No errors logged"} hint={filtersActive ? "Adjust the search, status, or date range — or clear filters." : "Errors the platform returns will appear here as they happen."} />
      ) : (
        <div className="rows">
          {items.map((e) => {
            const isOpen = expanded === e.id;
            return (
              <div className="row audit-row" key={e.id} style={{ cursor: "pointer" }} onClick={() => setExpanded(isOpen ? null : e.id)}>
                <div className="audit-head">
                  <Pill tone={toneFor(e.status)}>{e.status}</Pill>
                  <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{e.method}</span>
                  <span className="mono" style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.path}</span>
                </div>
                <span className="muted mono audit-time" style={{ fontSize: 11 }} title={fmt.dateTime(e.createdAt)}>{relativeTime(e.createdAt, fmt.date)}</span>
                <div className="muted audit-actor" style={{ fontSize: 12.5 }}>
                  {e.errorCode && <span className="mono">{e.errorCode}</span>}
                  {e.errorCode && (e.userId || e.actorName) && " · "}
                  {e.userId ? (
                    <button
                      type="button"
                      className="btn-ghost"
                      style={{ padding: 0, fontSize: 12.5 }}
                      title="Show everything this user hit"
                      onClick={(ev) => { ev.stopPropagation(); setQInput(e.userId ?? ""); }}
                    >
                      {e.actorName ?? e.actorEmail ?? "user"}
                    </button>
                  ) : (
                    <span>anonymous</span>
                  )}
                </div>
                {isOpen && (
                  <pre className="mono audit-json" style={{ fontSize: 11, padding: "8px 10px", background: "var(--surface-2)", borderRadius: "var(--radius-sm)", overflowX: "auto", color: "var(--muted)" }}>
{[
  `route   ${e.route}`,
  `path    ${e.path}`,
  e.actorEmail ? `user    ${e.actorName ?? ""} <${e.actorEmail}> (${e.userId})` : e.userId ? `user    ${e.userId}` : `user    anonymous`,
  e.message ? `message ${e.message}` : null,
  e.requestId ? `req id  ${e.requestId}` : null,
  e.durationMs != null ? `took    ${e.durationMs} ms` : null,
  `source  ${e.source}`,
  `at      ${fmt.dateTime(e.createdAt)}`,
].filter(Boolean).join("\n")}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
      <LoadMoreSentinel hasMore={hasMore && items.length > 0} loading={loading} onLoadMore={() => void loadPage(items.length, false)} />
      <ScrollToTop />
    </div>
  );
}
