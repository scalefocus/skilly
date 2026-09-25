"use client";
// Real user monitoring (SKILLY_SPEC.md §32.7) — platform-admin-only view of how the app performs in
// users' browsers: page traffic, Web Vitals, route-transition and API latency, client errors, per
// route. The collect switch + sample rate live in the header row of THIS page (not on
// Administration): the admin deciding whether to collect is looking at what collection produces.
// Data is fetched on mount and on range change only (no poll) — like the DAU chart.
import { useCallback, useEffect, useMemo, useState } from "react";
import nextDynamic from "next/dynamic";
import { EmptyState, Pill, Switch, useApi } from "../../../components/ui";
import { UserBubble } from "../../../components/UserBubble";
import { useDateFmt } from "../../../components/DateFormat";
import { readPref, writePref, PREF_RUM_RANGE, adminCardPrefKey } from "../../../lib/prefs";
import { OnlineUsersCard } from "../OnlineUsersCard";
import { SurveyResults } from "./SurveyResults";
import { bandFor, bandTone, formatCls, formatMs, VITAL_THRESHOLDS } from "../../../lib/rum/bands";
import { labelForRoute, RUM_ROUTE_ALL } from "../../../lib/rum/routes";
import { sortRouteRows } from "../../../lib/rum/sort";
import type { RumVital } from "../../../lib/rum/validate";

// recharts is heavy (d3) — code-split it out of the route's initial bundle.
const RumChart = nextDynamic(() => import("./RumChart").then((m) => m.RumChart), {
  ssr: false,
  loading: () => <div className="skeleton" style={{ height: 220, borderRadius: "var(--radius)" }} />,
});

type Range = 7 | 30 | 90 | "all";
const RANGES: { key: Range; label: string }[] = [
  { key: 7, label: "7d" },
  { key: 30, label: "30d" },
  { key: 90, label: "90d" },
  { key: "all", label: "All" },
];
const toRange = (s: string): Range => (s === "all" ? "all" : s === "30" ? 30 : s === "90" ? 90 : 7);
const SAMPLE_RATES = [100, 50, 25, 10, 1];

interface RouteRow {
  route: string;
  label: string;
  views: number;
  sessions: number;
  lcpP75: number | null;
  inpP75: number | null;
  clsP75: number | null;
  ttfbP75: number | null;
  navP75: number | null;
  apiP75: number | null;
  apiCalls: number;
  apiErrorRate: number | null;
  errors: number;
}
interface Summary {
  range: Range;
  bucket: "day" | "week" | "month";
  enabled: boolean;
  sampleRate: number;
  /** §32.4 the collector's flush ladder (ascending seconds; [0] is the floor). */
  flushIntervals: number[];
  lastSampleAt: string | null;
  series: { date: string; views: number; lcpP75: number | null; inpP75: number | null }[];
  routes: RouteRow[];
}
interface RouteUser {
  userId: string;
  displayName: string;
  email: string;
  avatar: string | null;
  samples: number;
  lcpP75: number | null;
  inpP75: number | null;
  errors: number;
}
interface ErrorRow {
  fingerprint: string;
  type: string;
  message: string;
  frame: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  routes: string[];
}

type SortKey = keyof Omit<RouteRow, "route" | "label">;
const COLUMNS: { key: SortKey; label: string; title: string }[] = [
  { key: "views", label: "Views", title: "Page views in the range" },
  { key: "sessions", label: "Sessions", title: "Distinct browser tabs that viewed the route" },
  { key: "lcpP75", label: "p75 LCP", title: "Largest Contentful Paint (document loads landing on this route)" },
  { key: "inpP75", label: "p75 INP", title: "Interaction to Next Paint (directional per route; exact on All routes)" },
  { key: "clsP75", label: "p75 CLS", title: "Cumulative Layout Shift while on this route" },
  { key: "ttfbP75", label: "p75 TTFB", title: "Time to First Byte (document loads landing on this route)" },
  { key: "navP75", label: "p75 nav", title: "Client-side route transition, click to first paint" },
  { key: "apiP75", label: "p75 API", title: "Browser-observed latency of /api calls made while on this route" },
  { key: "apiErrorRate", label: "API errors", title: "Share of /api calls that answered ≥ 400" },
  { key: "errors", label: "Client errors", title: "JavaScript errors and unhandled rejections" },
];
const ROLLUP_NOTE = "90d and All read the daily rollup: vitals are the views-weighted mean of each day's p75 (a percentile can't be re-aggregated).";

function VitalCell({ metric, value }: { metric: RumVital; value: number | null }) {
  if (value == null) return <span className="muted">—</span>;
  const band = bandFor(metric, value);
  const [good, poor] = VITAL_THRESHOLDS[metric];
  const text = metric === "cls" ? formatCls(value) : formatMs(value);
  const fmtT = (v: number) => (metric === "cls" ? formatCls(v) : formatMs(v));
  return (
    <span title={`${band.replace("-", " ")} · good ≤ ${fmtT(good)} · poor > ${fmtT(poor)}`}>
      <Pill tone={bandTone(band)}>{text}</Pill>
    </span>
  );
}

function MsCell({ value }: { value: number | null }) {
  return value == null ? <span className="muted">—</span> : <span className="mono">{formatMs(value)}</span>;
}

export default function RumPage() {
  const fmt = useDateFmt();
  const { data: me, loading: meLoading } = useApi<{ isPlatformAdmin?: boolean }>("/api/me");

  const [range, setRange] = useState<Range>(() => toRange(readPref(PREF_RUM_RANGE, "7")));
  const pickRange = (r: Range) => { setRange(r); writePref(PREF_RUM_RANGE, String(r)); };

  // "Currently online" (§4) — the collapsible presence card, first on this page. Collapsed by
  // default; the open state persists under the same `online` card key it had on Administration.
  // Unlike the range above, this page's header renders during SSR, so the stored value is read
  // after mount (null until then → the card waits) to avoid a hydration mismatch (lib/prefs.ts).
  const [onlineOpen, setOnlineOpen] = useState<boolean | null>(null);
  useEffect(() => { setOnlineOpen(readPref(adminCardPrefKey("online"), "0") === "1"); }, []);
  const toggleOnline = () => setOnlineOpen((o) => { const next = !o; writePref(adminCardPrefKey("online"), next ? "1" : "0"); return next; });

  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "views", dir: "desc" });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [users, setUsers] = useState<Record<string, RouteUser[] | "loading" | "error">>({});

  const [errors, setErrors] = useState<ErrorRow[]>([]);
  const [errorsTotal, setErrorsTotal] = useState(0);
  const [errorsSort, setErrorsSort] = useState<"lastSeen" | "count">("lastSeen");
  const [errorsLoading, setErrorsLoading] = useState(false);

  // Summary: mount, range change, and explicit reloads (settings PATCH, Refresh).
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/rum/summary?range=${range}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Request failed (${r.status})`);
        return r.json() as Promise<Summary>;
      })
      .then((j) => { if (live) setSummary(j); })
      .catch((e) => { if (live) setError(String((e as Error).message ?? e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [range, tick]);

  // Errors: first page on range change/reload; "Show more" appends.
  const loadErrors = useCallback(async (offset: number) => {
    setErrorsLoading(true);
    try {
      const r = await fetch(`/api/admin/rum/errors?range=${range}&offset=${offset}&limit=50`);
      if (!r.ok) return;
      const j = (await r.json()) as { errors: ErrorRow[]; total: number };
      setErrors((prev) => (offset === 0 ? j.errors : [...prev, ...j.errors]));
      setErrorsTotal(j.total);
    } finally {
      setErrorsLoading(false);
    }
  }, [range]);
  useEffect(() => {
    if (!me?.isPlatformAdmin) return;
    void loadErrors(0);
  }, [me?.isPlatformAdmin, loadErrors, tick]);

  // Drill-down cache is per range: a range change invalidates it.
  useEffect(() => { setUsers({}); setExpanded(null); }, [range]);

  const patch = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Failed (${r.status})`);
      setError(null);
      setTick((t) => t + 1);
      return true;
    } catch (e) {
      setError(String((e as Error).message));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // §32.6 the flush ladder field: a comma-separated draft, synced from the saved set whenever the
  // summary reloads, saved on blur / Enter, reverted to the saved set when the server rejects it.
  const savedIntervals = summary?.flushIntervals.join(", ") ?? "";
  const [intervalsDraft, setIntervalsDraft] = useState("");
  useEffect(() => { setIntervalsDraft(savedIntervals); }, [savedIntervals]);
  const saveIntervals = async () => {
    if (!summary || intervalsDraft.trim() === savedIntervals) return;
    const ok = await patch({ rumFlushIntervals: intervalsDraft });
    if (!ok) setIntervalsDraft(savedIntervals);
  };

  const toggleExpand = (route: string) => {
    if (expanded === route) { setExpanded(null); return; }
    setExpanded(route);
    if (users[route] || (range !== 7 && range !== 30)) return;
    setUsers((u) => ({ ...u, [route]: "loading" }));
    fetch(`/api/admin/rum/routes/${encodeURIComponent(route)}/users?range=${range}`)
      .then(async (r) => {
        if (!r.ok) throw new Error();
        return (await r.json()) as { users: RouteUser[] };
      })
      .then((j) => setUsers((u) => ({ ...u, [route]: j.users })))
      .catch(() => setUsers((u) => ({ ...u, [route]: "error" })));
  };

  // "All routes" is the totals row: pinned first, outside the sort (lib/rum/sort.ts).
  const sortedRoutes = useMemo(() => (summary ? sortRouteRows(summary.routes, sort.key, sort.dir) : []), [summary, sort]);

  const sortedErrors = useMemo(() => {
    const rows = [...errors];
    if (errorsSort === "count") rows.sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
    else rows.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    return rows;
  }, [errors, errorsSort]);

  const clickSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));

  if (!meLoading && me && !me.isPlatformAdmin) {
    return <EmptyState icon="🔒" title="Platform admins only" hint="Real user monitoring is restricted to platform administrators." />;
  }
  if (error && !summary) {
    const denied = /admin|unauthenticated/i.test(error);
    return <EmptyState icon={denied ? "🔒" : "⚠"} title={denied ? "Platform admins only" : "Couldn’t load real user monitoring"} hint={error} />;
  }

  const rollup = range === 90 || range === "all";
  const empty = !!summary && summary.routes.length === 0 && errors.length === 0;

  return (
    <div style={{ maxWidth: 1180 }}>
      <div className="page-head reveal">
        <div className="eyebrow">Administration</div>
        <h1 className="page-title">Real user monitoring.</h1>
        <p className="page-sub">How the app performs in your users’ browsers. Spot slow pages and usability issues before people report them. Platform admins only.</p>
      </div>

      {/* Currently online (§4): first section, above the telemetry settings; renders regardless of
          the RUM empty state below — a deployment with no samples still shows who is around. */}
      {onlineOpen === null
        ? <div className="skeleton" style={{ height: 58, borderRadius: "var(--radius)", marginBottom: 26 }} />
        : <OnlineUsersCard open={onlineOpen} onToggle={toggleOnline} />}

      {/* Header row: the collect switch + sample rate (§32.6), then the range toggle + refresh. */}
      <section className="card card-pad reveal" style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
            <Switch
              label="Collect telemetry"
              checked={summary?.enabled ?? true}
              disabled={busy || !summary}
              onChange={(next) => void patch({ rumEnabled: next })}
              title="Turning collection off stops every browser within a minute; history stays visible."
            />
            <label className="muted" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
              Sample
              {/* Same themed select as the admin page's "Maximum upload size" dropdown. */}
              <div className={`select-wrap${busy || !summary ? " is-disabled" : ""}`} style={{ width: 120 }}>
                <select
                  aria-label="Sample rate"
                  value={summary?.sampleRate ?? 100}
                  disabled={busy || !summary}
                  onChange={(e) => void patch({ rumSampleRate: Number(e.target.value) })}
                  style={{ width: "100%", padding: "10px 38px 10px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-mono)", fontSize: 14 }}
                >
                  {SAMPLE_RATES.map((r) => (
                    <option key={r} value={r}>{r} %</option>
                  ))}
                </select>
                <svg className="select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </div>
              of sessions
            </label>
            <label className="muted" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
              Flush every
              <input
                aria-label="Flush intervals (comma-separated seconds)"
                className="input input-mono"
                style={{ width: 210, padding: "9px 12px", fontSize: 13 }}
                value={intervalsDraft}
                placeholder="17, 23, 37, 59, 97, 157, 251"
                disabled={busy || !summary}
                onChange={(e) => setIntervalsDraft(e.target.value)}
                onBlur={() => void saveIntervals()}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
                title="The browser collector's flush ladder (seconds, ascending): an active tab beacons at the first value; an idle tab climbs one step per flush and snaps back on the next click, key press or page change."
              />
              s
            </label>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="sort-toggle" role="group" aria-label="Range">
              {RANGES.map((r) => (
                <button key={String(r.key)} type="button" className={`sort-opt${range === r.key ? " sort-on" : ""}`} onClick={() => pickRange(r.key)}>
                  {r.label}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-sm" disabled={loading} onClick={() => setTick((t) => t + 1)} title="Reload the numbers">
              Refresh
            </button>
          </div>
        </div>
        {summary && (
          <div className="muted" data-testid="rum-cadence" style={{ marginTop: 10, fontSize: 12 }}>
            Sampling {summary.sampleRate} % of sessions · beacons every {summary.flushIntervals[0]} s while active
            {summary.flushIntervals.length > 1 ? `, backing off to ${summary.flushIntervals[summary.flushIntervals.length - 1]} s when idle` : ""}.
          </div>
        )}
        {summary && !summary.enabled && (
          <div className="muted" role="status" style={{ marginTop: 12, fontSize: 13, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: "var(--radius)" }}>
            Collection is off — showing data collected until {summary.lastSampleAt ? fmt.dateTime(summary.lastSampleAt) : "—"}.
          </div>
        )}
        {error && summary && <div className="muted" style={{ marginTop: 10, fontSize: 13, color: "var(--danger)" }}>{error}</div>}
      </section>

      {empty ? (
        <EmptyState title="No samples yet" hint="Samples appear a few minutes after users start browsing." />
      ) : (
        <>
          {/* Trend chart */}
          <section className="card card-pad reveal" style={{ marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
              <span className="muted mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em" }}>Page views · p75 LCP · p75 INP</span>
              {summary && <span className="muted" style={{ fontSize: 12 }}>{summary.bucket === "day" ? "daily" : summary.bucket === "week" ? "weekly" : "monthly"}{rollup ? " · from the daily rollup" : ""}</span>}
            </div>
            {!summary ? (
              <div className="skeleton" style={{ height: 220, borderRadius: "var(--radius)" }} />
            ) : summary.series.length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>No samples in this range.</div>
            ) : (
              <RumChart points={summary.series} bucket={summary.bucket} />
            )}
          </section>

          {/* Routes table */}
          <section className="card reveal" style={{ marginBottom: 18, overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span className="muted mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em" }}>Routes</span>
              <span className="muted" style={{ fontSize: 12 }}>{rollup ? ROLLUP_NOTE : "Click a row to see who was affected."}</span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="rum-table" data-testid="rum-routes">
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Route</th>
                    {COLUMNS.map((c) => (
                      <th key={c.key} title={rollup && /P75/.test(c.key) ? `${c.title}. ${ROLLUP_NOTE}` : c.title} aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                        <button type="button" className={`rum-sort${sort.key === c.key ? " on" : ""}`} onClick={() => clickSort(c.key)}>
                          {c.label}{sort.key === c.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedRoutes.map((r) => {
                    const isAll = r.route === RUM_ROUTE_ALL;
                    const open = expanded === r.route;
                    const u = users[r.route];
                    return (
                      <RouteRows key={r.route} row={r} isAll={isAll} open={open} onToggle={() => toggleExpand(r.route)}>
                        {open && (
                          <tr className="rum-expand">
                            <td colSpan={COLUMNS.length + 1}>
                              {!(range === 7 || range === 30) ? (
                                <div className="muted" style={{ fontSize: 13 }}>Switch to 7d or 30d to see who was affected.</div>
                              ) : u === "loading" || u === undefined ? (
                                <div className="skeleton" style={{ height: 40, borderRadius: "var(--radius)" }} />
                              ) : u === "error" ? (
                                <div className="muted" style={{ fontSize: 13 }}>Couldn’t load the drill-down.</div>
                              ) : u.length === 0 ? (
                                <div className="muted" style={{ fontSize: 13 }}>No attributable samples (erased users are anonymised).</div>
                              ) : (
                                <div className="rows" data-testid="rum-users">
                                  {u.map((p) => (
                                    <div className="row" key={p.userId} style={{ padding: "10px 14px" }}>
                                      <UserBubble name={p.displayName} avatar={p.avatar} userId={p.userId} size={26} />
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div className="ttl" style={{ fontSize: 13 }}>{p.displayName}</div>
                                        <div className="sub mono" style={{ fontSize: 11 }}>{p.email}</div>
                                      </div>
                                      <span className="muted mono" style={{ fontSize: 12 }}>{p.samples} samples</span>
                                      <VitalCell metric="lcp" value={p.lcpP75} />
                                      <VitalCell metric="inp" value={p.inpP75} />
                                      <span className="muted mono" style={{ fontSize: 12 }}>{p.errors} err</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </RouteRows>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Client errors */}
          <section className="card reveal" style={{ marginBottom: 18, overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className="muted mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em" }}>Client errors · {errorsTotal}</span>
              <div className="sort-toggle" role="group" aria-label="Sort errors">
                <button type="button" className={`sort-opt${errorsSort === "lastSeen" ? " sort-on" : ""}`} onClick={() => setErrorsSort("lastSeen")}>Last seen</button>
                <button type="button" className={`sort-opt${errorsSort === "count" ? " sort-on" : ""}`} onClick={() => setErrorsSort("count")}>Count</button>
              </div>
            </div>
            {sortedErrors.length === 0 ? (
              <div className="muted" style={{ padding: "16px 18px", fontSize: 13 }}>{errorsLoading ? "Loading…" : "No client errors in this range."}</div>
            ) : (
              <div data-testid="rum-errors">
                {sortedErrors.map((e) => (
                  <div className="row" key={e.fingerprint} style={{ alignItems: "flex-start" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="mono" style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${e.type}: ${e.message}`}>
                        <span style={{ color: "var(--danger)" }}>{e.type}</span>: {e.message}
                      </div>
                      <div className="sub mono" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.frame || undefined}>{e.frame || "—"}</div>
                      {e.routes.length > 0 && (
                        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                          {e.routes.map((r) => <Pill key={r} tone="muted">{labelForRoute(r)}</Pill>)}
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div className="mono" style={{ fontSize: 14, fontWeight: 600 }}>{e.count}×</div>
                      <div className="sub" style={{ fontSize: 11 }} title={`first ${fmt.dateTime(e.firstSeen)}`}>last {fmt.dateTime(e.lastSeen)}</div>
                    </div>
                  </div>
                ))}
                {errors.length < errorsTotal && (
                  <div style={{ padding: "10px 18px", borderTop: "1px solid var(--line)" }}>
                    <button type="button" className="btn btn-sm" disabled={errorsLoading} onClick={() => void loadErrors(errors.length)}>Show more</button>
                  </div>
                )}
              </div>
            )}
          </section>
        </>
      )}

      {/* 6. Survey results (§36.9): follows the page range and Refresh; renders regardless of the
          RUM empty state and of rum_enabled. */}
      {me?.isPlatformAdmin && <SurveyResults range={range} refreshTick={tick} />}
    </div>
  );
}

/** One route row (+ its optional expansion row, passed as children so the tbody stays flat). */
function RouteRows({ row: r, isAll, open, onToggle, children }: { row: RouteRow; isAll: boolean; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <>
      <tr className={`rum-row${isAll ? " rum-all" : ""}${open ? " open" : ""}`} onClick={onToggle} aria-expanded={open} data-route={r.route}>
        <td style={{ textAlign: "left" }}>
          <span title={isAll ? "Every route" : r.route} style={{ fontWeight: isAll ? 600 : 500 }}>{r.label}</span>
        </td>
        <td className="mono">{r.views.toLocaleString()}</td>
        <td className="mono">{r.sessions.toLocaleString()}</td>
        <td><VitalCell metric="lcp" value={r.lcpP75} /></td>
        <td><VitalCell metric="inp" value={r.inpP75} /></td>
        <td><VitalCell metric="cls" value={r.clsP75} /></td>
        <td><VitalCell metric="ttfb" value={r.ttfbP75} /></td>
        <td><MsCell value={r.navP75} /></td>
        <td><MsCell value={r.apiP75} /></td>
        <td className="mono" title={`${r.apiCalls.toLocaleString()} calls`}>{r.apiErrorRate == null ? <span className="muted">—</span> : `${(r.apiErrorRate * 100).toFixed(1)} %`}</td>
        <td className="mono" title={r.views > 0 ? `${((r.errors / r.views) * 100).toFixed(1)} per 100 views` : undefined}>{r.errors.toLocaleString()}</td>
      </tr>
      {children}
    </>
  );
}
