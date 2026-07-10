"use client";
import { useCallback, useEffect, useState } from "react";
import { downloadFile, EmptyState, LoadMoreSentinel, Pill, ScrollToTop, useApi } from "../../components/ui";
import { useDateFmt } from "../../components/DateFormat";
import { DateRangeFilter, dayStartIso, dayEndIso } from "../../components/DateRangeFilter";

const PAGE = 100;

interface AuditView {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  namespaceSlug: string | null;
  actorName: string | null;
  actorEmail: string | null;
  before: unknown;
  after: unknown;
  source: string;
  createdAt: string;
}

function toneFor(action: string): "ok" | "warn" | "danger" | "muted" {
  if (/reject|yank|archiv/.test(action)) return "danger";
  if (/override|request_changes/.test(action)) return "warn";
  if (/accept|publish|restore|created/.test(action)) return "ok";
  return "muted";
}

const FILTERS = [
  { label: "All", value: "" },
  { label: "Proposals", value: "proposal." },
  { label: "Skills", value: "skill." },
  { label: "Versions", value: "version." },
];

export default function AuditPage() {
  const fmt = useDateFmt();
  const [action, setAction] = useState("");
  // Optional filters layered on the default newest-100 view: debounced search + a From/To date
  // range (yyyy-mm-dd local strings, "" = unset). Any change resets the list to page 0.
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  useEffect(() => { const t = setTimeout(() => setQ(qInput.trim()), 300); return () => clearTimeout(t); }, [qInput]);
  const filtersActive = !!action || !!q || !!from || !!to;
  const clearFilters = () => { setAction(""); setQInput(""); setQ(""); setFrom(""); setTo(""); };
  // Infinite scroll: newest-first pages of 100, accumulated; a filter change resets the list.
  const [items, setItems] = useState<AuditView[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; entries: number; mismatches: { seq: number; reason: string }[] } | null>(null);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  // Trim is platform-admin only (the API also enforces it); show the control only to admins.
  const { data: me } = useApi<{ isPlatformAdmin: boolean }>("/api/me");
  const isAdmin = !!me?.isPlatformAdmin;
  const [trimBusy, setTrimBusy] = useState(false);
  const [trimMsg, setTrimMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const loadPage = useCallback(async (offset: number, reset: boolean) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (action) qs.set("action", action);
      if (q) qs.set("q", q);
      if (from) qs.set("from", dayStartIso(from));
      if (to) qs.set("to", dayEndIso(to));
      const r = await fetch(`/api/audit?${qs}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Request failed (${r.status})`);
      const j = (await r.json()) as { items: AuditView[] };
      setItems((prev) => (reset ? j.items : [...prev, ...j.items]));
      setHasMore(j.items.length === PAGE);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, [action, q, from, to]);

  useEffect(() => {
    setItems([]);
    setHasMore(true);
    void loadPage(0, true);
  }, [loadPage]);

  const runVerify = async () => {
    setVerify(null); setVerifyMsg(null);
    const r = await fetch("/api/audit/verify");
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setVerifyMsg(j.error ?? "verification failed"); return; }
    setVerify(j);
  };

  // Export honors the SAME active filters as the on-screen list (action/search/date range) — not
  // a separate "everything" dump, unlike Trim/Verify below which always act on the full chain.
  const exportCsv = async () => {
    setExportBusy(true); setExportMsg(null);
    try {
      const qs = new URLSearchParams();
      if (action) qs.set("action", action);
      if (q) qs.set("q", q);
      if (from) qs.set("from", dayStartIso(from));
      if (to) qs.set("to", dayEndIso(to));
      const { total, exported } = await downloadFile(`/api/audit/export?${qs}`);
      if (total > exported) {
        setExportMsg({ kind: "ok", text: `Exported the most recent ${exported.toLocaleString()} of ${total.toLocaleString()} matching entries — narrow the date range to get the rest.` });
      }
    } catch (e) {
      setExportMsg({ kind: "err", text: String((e as Error).message) });
    } finally {
      setExportBusy(false);
    }
  };

  const trim = async () => {
    if (!window.confirm("Delete all audit events older than one year?\n\nThis permanently removes them and re-baselines the tamper-evident hash chain over what remains. This cannot be undone.")) return;
    setTrimBusy(true); setTrimMsg(null); setVerify(null);
    try {
      const r = await fetch("/api/audit/trim", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Failed (${r.status})`);
      setTrimMsg({ kind: "ok", text: `Trimmed ${j.deleted} event${j.deleted === 1 ? "" : "s"} older than one year.` });
      setItems([]); setHasMore(true); void loadPage(0, true); // refresh the list
    } catch (e) {
      setTrimMsg({ kind: "err", text: String((e as Error).message) });
    } finally {
      setTrimBusy(false);
    }
  };

  if (error && items.length === 0) {
    const denied = /admin/i.test(error);
    return <EmptyState icon={denied ? "🔒" : "⚠"} title={denied ? "Admins only" : "Couldn’t load the audit log"} hint={error} />;
  }

  return (
    <div style={{ maxWidth: 980 }}>
      <div className="page-head reveal">
        <div className="eyebrow">Governance</div>
        <h1 className="page-title">Audit log.</h1>
        <p className="page-sub">Append-only record of who did what. Platform admins see everything; namespace admins see their namespaces.</p>
      </div>

      {/* Filter bar — narrowing the view (kept separate from the destructive admin tools below). */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        {FILTERS.map((f) => (
          <button
            key={f.value}
            className={`btn btn-sm${action === f.value ? " btn-primary" : ""}`}
            onClick={() => setAction(f.value)}
          >
            {f.label}
          </button>
        ))}
        <div className="search" style={{ maxWidth: 320, minWidth: 200 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search action, target, namespace, or actor…" aria-label="Search audit log" />
        </div>
        <DateRangeFilter from={from} to={to} onChange={({ from: f, to: t }) => { setFrom(f); setTo(t); }} />
        {filtersActive && (
          <button className="btn-ghost mono" style={{ fontSize: 12 }} onClick={clearFilters}>✕ clear filters</button>
        )}
      </div>

      {/* Admin tools. Export honors the filters above (it downloads what you're looking at);
          Trim/Verify operate on the full chain regardless of them. */}
      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ flex: 1 }} />
        {isAdmin && (
          <button
            className="btn btn-sm"
            onClick={exportCsv}
            disabled={exportBusy}
            title="Download the currently filtered entries as a CSV file (capped at 50,000 rows)"
          >
            {exportBusy ? "Exporting…" : "↓ Export CSV"}
          </button>
        )}
        {isAdmin && (
          <button
            className="btn btn-sm btn-danger"
            onClick={trim}
            disabled={trimBusy}
            title="When pressed, all events older than one year will be permanently deleted (you'll be asked to confirm)."
          >
            {trimBusy ? "Trimming…" : "Trim events"}
          </button>
        )}
        <button className="btn btn-sm" onClick={runVerify} title="Recompute the audit hash chain (platform admin)">Verify integrity</button>
      </div>
      {exportMsg && (
        <div className="card card-pad" style={{ marginBottom: 16, fontSize: 13.5, color: exportMsg.kind === "err" ? "var(--danger)" : "var(--ok)" }}>
          {exportMsg.text}
        </div>
      )}

      {isAdmin && (
        <p className="muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 16 }}>
          <strong>Trim events</strong> permanently deletes all audit entries older than one year (you’ll confirm first); the tamper-evident chain is then re-baselined over what remains.
        </p>
      )}
      {trimMsg && (
        <div className="card card-pad" style={{ marginBottom: 16, fontSize: 13.5, color: trimMsg.kind === "err" ? "var(--danger)" : "var(--ok)" }}>
          {trimMsg.text}
        </div>
      )}

      {verifyMsg && <div className="card card-pad" style={{ marginBottom: 16, color: "var(--danger)", fontSize: 13.5 }}>{verifyMsg}</div>}
      {verify && (
        <div className="card card-pad" style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
          <Pill tone={verify.ok ? "ok" : "danger"}>{verify.ok ? "chain intact" : "TAMPERING DETECTED"}</Pill>
          <span className="muted" style={{ fontSize: 13.5 }}>
            {verify.entries} entries verified
            {verify.mismatches.length > 0 && ` · broken at seq ${verify.mismatches.map((m) => m.seq).join(", ")}`}
          </span>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="skeleton" style={{ height: 260, borderRadius: "var(--radius)" }} />
      ) : items.length === 0 ? (
        <EmptyState title={filtersActive ? "No matching audit entries" : "No audit entries"} hint={filtersActive ? "Adjust the search, category, or date range — or clear filters." : "Governance actions will appear here as they happen."} />
      ) : (
        <div className="rows">
          {items.map((a) => (
            <div className="row audit-row" key={a.id}>
              <div className="audit-head">
                <Pill tone={toneFor(a.action)}>{a.action}</Pill>
                {a.namespaceSlug && <span className="ns" style={{ fontSize: 13 }}>@{a.namespaceSlug}</span>}
                <span className="muted mono" style={{ fontSize: 11 }}>{a.targetType}{a.targetId ? `:${a.targetId}` : ""}</span>
              </div>
              <span className="muted mono audit-time" style={{ fontSize: 11 }}>{fmt.dateTime(a.createdAt)}</span>
              <div className="muted audit-actor" style={{ fontSize: 12.5 }}>
                {a.actorName ?? "system"}{a.actorEmail ? ` · ${a.actorEmail}` : ""} · <span className="mono">{a.source}</span>
              </div>
              {(a.after != null || a.before != null) && (
                <pre className="mono audit-json" style={{ fontSize: 11, padding: "8px 10px", background: "var(--surface-2)", borderRadius: "var(--radius-sm)", overflowX: "auto", color: "var(--muted)" }}>
                  {JSON.stringify(a.after ?? a.before, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
      <LoadMoreSentinel hasMore={hasMore && items.length > 0} loading={loading} onLoadMore={() => void loadPage(items.length, false)} />
      <ScrollToTop />
    </div>
  );
}
