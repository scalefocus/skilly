"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useApi, useEnterKey, EmptyState, Pill, ScrollToTop, formatCount } from "../../components/ui";
import { agentLabel } from "@skilly/shared/agents";
import { readPref, writePref, PREF_PLATFORM_RANGE, PREF_SKILL_RANGE } from "../../lib/prefs";

// recharts is heavy (d3) and only needed once charts render — code-split it out of the route's
// initial bundle. ssr:false since charts measure the DOM; a skeleton holds the chart's height.
const UsageChart = dynamic(() => import("./UsageCharts").then((m) => m.UsageChart), {
  ssr: false,
  loading: () => <div className="skeleton" style={{ height: 180, marginTop: 18, borderRadius: "var(--radius)" }} />,
});
const Sparkline = dynamic(() => import("./UsageCharts").then((m) => m.Sparkline), { ssr: false });
// Per-skill chart bound to the breakdown window (so chart + people lists show the same period).
const WindowChart = dynamic(() => import("./UsageCharts").then((m) => m.WindowChart), {
  ssr: false,
  loading: () => <div className="skeleton" style={{ height: 150, borderRadius: "var(--radius)" }} />,
});

interface MetricWindows { d1: number; d1Prev: number; d7: number; d7Prev: number; d30: number; d30Prev: number; all: number }
interface DailySeries { views: number[]; installs: number[] }
interface SkillUsage { namespaceSlug: string; skillSlug: string; title: string; toolHarness: string; views: MetricWindows; installs: MetricWindows; daily: DailySeries }
interface UsageAggregate { scope: "platform" | "namespace"; views: MetricWindows; installs: MetricWindows; series: DailySeries }
interface UsageDashboard { aggregate: UsageAggregate | null; skills: SkillUsage[]; seriesDays: string[] }

// One range vocabulary for every filter on the page (matches the skill-detail chart): 7d/30d/90d/All.
type SkillRange = "7d" | "30d" | "90d" | "all";
type Range = 7 | 30 | 90 | "all";
const RANGES: { key: Range; label: string }[] = [
  { key: 7, label: "7d" },
  { key: 30, label: "30d" },
  { key: 90, label: "90d" },
  { key: "all", label: "All" },
];
const SKILL_RANGES: { key: SkillRange; label: string }[] = [
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "90d", label: "90d" },
  { key: "all", label: "All" },
];
// How many skill rows to render per infinite-scroll page.
const USAGE_PAGE = 100;
// Coerce a remembered (localStorage) string back to a valid range, falling back to the default.
const toPlatformRange = (s: string): Range => (s === "all" ? "all" : s === "7" ? 7 : s === "90" ? 90 : 30);
const toSkillRange = (s: string): SkillRange => (s === "7d" || s === "90d" || s === "all" ? s : "30d");
interface Breakdown {
  range: SkillRange;
  viewers: { displayName: string; email: string; count: number }[];
  installers: { displayName: string; email: string; count: number }[];
  anonymousInstalls: number;
  systemInstalls: number;
  series: { bucket: "hour" | "day" | "week" | "month"; points: { date: string; views: number; installs: number }[] };
}
const RANGE_LABEL: Record<SkillRange, string> = { "7d": "last 7 days", "30d": "last 30 days", "90d": "last 90 days", all: "all time" };

// Trend delta vs the prior equal window: ↑/↓ %, "new" when prior=0 & cur>0, "—" when both 0.
function Delta({ cur, prev }: { cur: number; prev: number }) {
  if (cur === 0 && prev === 0) return <span style={{ color: "var(--faint)", fontSize: 11 }}>—</span>;
  if (prev === 0) return <span style={{ color: "var(--accent-2)", fontSize: 11, fontFamily: "var(--font-mono)" }}>new</span>;
  const pct = Math.round(((cur - prev) / prev) * 100);
  const up = pct > 0;
  const flat = pct === 0;
  return (
    <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: flat ? "var(--faint)" : up ? "var(--ok)" : "var(--danger)" }}>
      {flat ? "0%" : `${up ? "▲" : "▼"}${Math.abs(pct)}%`}
    </span>
  );
}

const WINDOWS: { key: keyof Pick<MetricWindows, "d1" | "d7" | "d30" | "all">; prev?: keyof MetricWindows; label: string }[] = [
  { key: "d1", prev: "d1Prev", label: "24h" },
  { key: "d7", prev: "d7Prev", label: "7d" },
  { key: "d30", prev: "d30Prev", label: "30d" },
  { key: "all", label: "all" },
];

function MetricStrip({ m }: { m: MetricWindows }) {
  return (
    <div className="metric-strip" style={{ display: "flex", gap: 14 }}>
      {WINDOWS.map((w) => (
        <div key={w.label} style={{ minWidth: 44 }}>
          <div className="mono" style={{ fontSize: 10.5, color: "var(--faint)", textTransform: "uppercase", letterSpacing: "0.1em" }}>{w.label}</div>
          <div style={{ fontSize: 17, fontFamily: "var(--font-display)", lineHeight: 1.15 }}>{formatCount(m[w.key])}</div>
          {w.prev ? <Delta cur={m[w.key]} prev={m[w.prev]} /> : <span style={{ fontSize: 11, color: "transparent" }}>·</span>}
        </div>
      ))}
    </div>
  );
}


function Usage() {
  // The chosen windows are remembered across visits (SKILLY_SPEC.md §21). The platform-totals
  // window and a single shared per-skill window — the latter lifted here so the last pick is the
  // default for every skill row (this session and the next).
  const [range, setRange] = useState<Range>(() => toPlatformRange(readPref(PREF_PLATFORM_RANGE, "30")));
  const pickPlatformRange = (r: Range) => { setRange(r); writePref(PREF_PLATFORM_RANGE, String(r)); };
  const [skillRange, setSkillRange] = useState<SkillRange>(() => toSkillRange(readPref(PREF_SKILL_RANGE, "30d")));
  const pickSkillRange = (r: SkillRange) => { setSkillRange(r); writePref(PREF_SKILL_RANGE, r); };
  // Search is driven by the global header box (§10): on /usage it writes ?q=, which we read here and
  // feed to the dashboard fetch (server-side ILIKE over title/slug/namespace, spanning the whole
  // entitled list — not just the rows scrolled into view). Enter anywhere focuses that header box.
  const searchParams = useSearchParams();
  const qSubmitted = (searchParams.get("q") ?? "").trim();
  useEnterKey(() => window.dispatchEvent(new Event("skilly:focus-search")));
  // Client-side refinement chips (catalog-style) over the returned page.
  const [nsFilter, setNsFilter] = useState<string | null>(null);
  const [toolFilter, setToolFilter] = useState<string | null>(null);
  // Sort the skill list by all-time total installs or views (catalog-style toggle).
  const [sortBy, setSortBy] = useState<"installs" | "views">("installs");
  // Infinite scroll: render the first USAGE_PAGE rows, then USAGE_PAGE more each time the sentinel
  // scrolls into view. Reset whenever the filtered/sorted set changes so we always start at the top.
  const [visible, setVisible] = useState(USAGE_PAGE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setVisible(USAGE_PAGE); }, [qSubmitted, nsFilter, toolFilter, sortBy, range]);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return; // only mounted while more rows remain
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) setVisible((v) => v + USAGE_PAGE);
    }, { rootMargin: "400px" });
    io.observe(node);
    return () => io.disconnect();
  }, [visible]);

  const { data, loading, error } = useApi<UsageDashboard>(`/api/usage?days=${range}${qSubmitted ? `&q=${encodeURIComponent(qSubmitted)}` : ""}`);

  if (error) {
    const denied = /unknown user|unauth/i.test(error);
    return <EmptyState icon={denied ? "🔒" : "⚠"} title={denied ? "Sign in required" : "Couldn’t load usage"} hint={error} />;
  }
  if (!data && loading) return <div className="skeleton" style={{ height: 260, borderRadius: "var(--radius)" }} />;
  if (!data) return null;

  const namespaces = [...new Set(data.skills.map((s) => s.namespaceSlug))].sort();
  const tools = [...new Set(data.skills.map((s) => s.toolHarness))].sort();
  // Sort by the chosen all-time total, with deterministic tiebreakers (the other metric, then
  // title) so a filtered subset where many skills tie (e.g. all 0 installs) still orders sensibly
  // instead of falling back to the server's incoming order.
  const shown = data.skills
    .filter((s) => (!nsFilter || s.namespaceSlug === nsFilter) && (!toolFilter || s.toolHarness === toolFilter))
    .sort((a, b) =>
      sortBy === "installs"
        ? b.installs.all - a.installs.all || b.views.all - a.views.all || a.title.localeCompare(b.title)
        : b.views.all - a.views.all || b.installs.all - a.installs.all || a.title.localeCompare(b.title),
    );

  return (
    <div style={{ maxWidth: 980 }}>
      <ScrollToTop />
      <div className="page-head reveal" style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow">Analytics</div>
          <h1 className="page-title">Usage.</h1>
          <p className="page-sub">View &amp; install tendencies for the skills you own. Trends compare each window to the one before it.</p>
        </div>
        <div className="sort-toggle" role="group" aria-label="Chart range">
          {RANGES.map((r) => (
            <button key={r.key} type="button" className={`sort-opt${range === r.key ? " sort-on" : ""}`} onClick={() => pickPlatformRange(r.key)}>{r.label}</button>
          ))}
        </div>
      </div>

      {data.aggregate && (
        <section className="card card-pad reveal" style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>{data.aggregate.scope === "platform" ? "Platform total" : "Your namespaces"}</h2>
            <Pill tone="muted">{data.aggregate.scope}</Pill>
          </div>
          <div style={{ display: "flex", gap: 40, flexWrap: "wrap" }}>
            <div className="usage-metric-block">
              <div className="nav-label" style={{ padding: "0 0 8px" }}>Installs</div>
              <MetricStrip m={data.aggregate.installs} />
            </div>
            <div className="usage-metric-block">
              <div className="nav-label" style={{ padding: "0 0 8px" }}>Views</div>
              <MetricStrip m={data.aggregate.views} />
            </div>
          </div>
          <UsageChart days={data.seriesDays} series={data.aggregate.series} />
          <div className="muted mono" style={{ fontSize: 11, marginTop: 6 }}>
            <span style={{ color: "var(--accent)" }}>—</span> installs · <span style={{ color: "var(--faint)" }}>—</span> views · {range === "all" ? "all time" : `last ${range} days`}
          </div>
        </section>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22 }}>Skills</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="muted mono" style={{ fontSize: 12 }}>{shown.length} shown</span>
          <div className="sort-toggle" role="group" aria-label="Sort by">
            <button type="button" className={`sort-opt${sortBy === "installs" ? " sort-on" : ""}`} onClick={() => setSortBy("installs")}>Installs</button>
            <button type="button" className={`sort-opt${sortBy === "views" ? " sort-on" : ""}`} onClick={() => setSortBy("views")}>Views</button>
          </div>
        </div>
      </div>

      {/* Refinement chips (catalog-style) refine the returned page; the free-text search itself is the
          global header box (§10 — placeholder "Search usage…", drives ?q=). Shown only when there's
          more than one namespace/tool to filter by. */}
      {(namespaces.length > 1 || tools.length > 1) && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
          {namespaces.length > 1 && namespaces.map((n) => (
            <button key={n} type="button" className={`facet${nsFilter === n ? " facet-on" : ""}`} onClick={() => setNsFilter(nsFilter === n ? null : n)}>@{n}</button>
          ))}
          {tools.length > 1 && tools.map((t) => (
            <button key={t} type="button" className={`facet${toolFilter === t ? " facet-on" : ""}`} onClick={() => setToolFilter(toolFilter === t ? null : t)}>{agentLabel(t)}</button>
          ))}
          {(nsFilter || toolFilter) && (
            <button className="btn-ghost mono" style={{ fontSize: 12 }} onClick={() => { setNsFilter(null); setToolFilter(null); }}>✕ clear</button>
          )}
        </div>
      )}

      {shown.length === 0 ? (
        <EmptyState
          title={qSubmitted || nsFilter || toolFilter ? "No skills match your filters" : "No skills to report yet"}
          hint={qSubmitted || nsFilter || toolFilter ? "Try a different search or clear filters." : "Usage appears here for skills you own or maintain once they’re viewed or installed."}
        />
      ) : (
        <>
          <div className="rows">
            {shown.slice(0, visible).map((s) => (
              <SkillRow key={`${s.namespaceSlug}/${s.skillSlug}`} s={s} seriesDays={data.seriesDays} skillRange={skillRange} onPickRange={pickSkillRange} />
            ))}
          </div>
          {visible < shown.length && (
            <div ref={sentinelRef} className="muted mono" style={{ textAlign: "center", padding: "16px 0", fontSize: 12 }}>
              Loading more… {Math.min(visible, shown.length)} of {shown.length}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// useSearchParams() must sit under a Suspense boundary (Next.js App Router), mirroring the catalog.
export default function UsagePage() {
  return (
    <Suspense fallback={<div className="skeleton" style={{ height: 260, borderRadius: "var(--radius)" }} />}>
      <Usage />
    </Suspense>
  );
}

function SkillRow({ s, seriesDays, skillRange, onPickRange }: { s: SkillUsage; seriesDays: string[]; skillRange: SkillRange; onPickRange: (r: SkillRange) => void }) {
  const [open, setOpen] = useState(false);
  const [bd, setBd] = useState<Breakdown | null>(null);
  const [loadingBd, setLoadingBd] = useState(false);

  const loadBreakdown = async (r: SkillRange) => {
    setLoadingBd(true);
    try {
      const res = await fetch(`/api/usage/${s.namespaceSlug}/${s.skillSlug}/breakdown?range=${r}`);
      setBd(res.ok ? await res.json() : null);
    } catch { setBd(null); } finally { setLoadingBd(false); }
  };

  // (Re)load the breakdown whenever the row is open and the shared window changes — so every open
  // row follows the last-picked range. Collapsed rows don't fetch.
  useEffect(() => {
    if (open) void loadBreakdown(skillRange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, skillRange]);

  const toggle = () => setOpen((o) => !o);

  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      {/* The whole header row is the toggle: expand → full chart + who-breakdown. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
        }}
        title={open ? "Collapse" : "Expand chart and breakdown"}
        style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", cursor: "pointer" }}
      >
        <span aria-hidden className="muted" style={{ width: 14, flexShrink: 0, fontSize: 11 }}>{open ? "▾" : "▸"}</span>
        <div style={{ minWidth: 180, flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{s.title}</div>
          <div className="ns mono" style={{ fontSize: 12 }}>@{s.namespaceSlug}/{s.skillSlug}</div>
        </div>
        {!open && <div className="usage-spark"><Sparkline days={seriesDays} s={s.daily} /></div>}
        <div className="usage-metric-block">
          <div className="nav-label" style={{ padding: "0 0 6px" }}>Installs</div>
          <MetricStrip m={s.installs} />
        </div>
        <div className="usage-metric-block">
          <div className="nav-label" style={{ padding: "0 0 6px" }}>Views</div>
          <MetricStrip m={s.views} />
        </div>
      </div>

      {open && (
        <div className="usage-expand" style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 4 }}>
          {/* Expanded: a full chart bound to the SAME window as the breakdown filter below it, so
              the chart and the viewers/installers lists always show the same period. */}
          {bd ? (
            <>
              <WindowChart points={bd.series.points} bucket={bd.series.bucket} height={150} />
              <div className="muted mono" style={{ fontSize: 11, margin: "6px 0 14px" }}>
                <span style={{ color: "var(--accent)" }}>—</span> installs · <span style={{ color: "var(--faint)" }}>—</span> views · {RANGE_LABEL[skillRange]}
              </div>
            </>
          ) : (
            <div className="skeleton" style={{ height: 150, margin: "0 0 14px", borderRadius: "var(--radius)" }} />
          )}
          {/* …and the who-breakdown (previously behind the "who?" button) opens with it. */}
          <div className="sort-toggle" role="group" aria-label="Range" style={{ marginBottom: 12 }}>
            {SKILL_RANGES.map((r) => (
              <button key={r.key} type="button" className={`sort-opt${skillRange === r.key ? " sort-on" : ""}`} onClick={() => onPickRange(r.key)}>{r.label}</button>
            ))}
          </div>
          {loadingBd ? (
            <div className="muted" style={{ fontSize: 13 }}>Loading…</div>
          ) : !bd ? (
            <div className="muted" style={{ fontSize: 13 }}>No breakdown available.</div>
          ) : (
            <div style={{ display: "flex", gap: 40, flexWrap: "wrap" }}>
              <PeopleList
                title="Top installers"
                people={bd.installers}
                extra={[
                  bd.systemInstalls > 0 ? `+ ${bd.systemInstalls} System install${bd.systemInstalls === 1 ? "" : "s"}` : null,
                  bd.anonymousInstalls > 0 ? `+ ${bd.anonymousInstalls} anonymous (tokenless)` : null,
                ].filter(Boolean).join(" · ") || null}
              />
              <PeopleList title="Top viewers" people={bd.viewers} extra={null} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Lists longer than this collapse to the top N with a Show more/less toggle (independent per list).
const PEOPLE_COLLAPSE_AT = 5;

function PeopleList({ title, people, extra }: { title: string; people: { displayName: string; email: string; count: number }[]; extra: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const overflows = people.length > PEOPLE_COLLAPSE_AT;
  const shown = expanded || !overflows ? people : people.slice(0, PEOPLE_COLLAPSE_AT);
  return (
    <div style={{ minWidth: 240 }}>
      <div className="nav-label" style={{ padding: "0 0 8px" }}>{title}</div>
      {people.length === 0 && !extra ? (
        <div className="muted" style={{ fontSize: 13 }}>None in this window.</div>
      ) : (
        <div className="rows">
          {shown.map((p) => (
            <div className="row" key={p.email}>
              <div className="grow">
                <div className="ttl">{p.displayName}</div>
                <div className="sub mono" style={{ fontSize: 11 }}>{p.email}</div>
              </div>
              <span className="chip">{formatCount(p.count)}</span>
            </div>
          ))}
          {/* The tokenless-installs note is a centered row INSIDE the rounded .rows box — no border
              of its own (that nested a second box); the preceding row's bottom divider separates it. */}
          {extra && (
            <div className="muted mono" style={{ fontSize: 11, padding: "11px 20px", textAlign: "center" }}>
              {extra}
            </div>
          )}
        </div>
      )}
      {overflows && (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          style={{ marginTop: 8 }}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : `Show more (${people.length - PEOPLE_COLLAPSE_AT})`}
        </button>
      )}
    </div>
  );
}
