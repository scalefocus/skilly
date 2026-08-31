"use client";
// Requested skills (§26): open skill requests, in the catalog's card/row language. Org-visible.
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useApi, useEnterKey, SkeletonGrid, EmptyState, ScrollToTop, Pill } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { UserBubble } from "../../components/UserBubble";
import { useDateFmt } from "../../components/DateFormat";
import { agentLabel } from "@skilly/shared/agents";
import { plainText, descTooltip } from "../../lib/cardText";
import { CollapsibleFacetRow, FacetRow } from "../../components/CollapsibleFacetRow";
import { initialFacetRowOpen, storedFacetRowOpen } from "../../lib/facetRow";

/** Mirrors `RequestFacets` from lib/requests (server-only module — the shape is restated here the
 *  same way the catalog page restates its own `Facets`). */
interface RequestFacets {
  categories: { name: string; count: number }[];
  tools: { name: string; count: number }[];
}

export interface RequestEntry {
  id: string;
  title: string;
  description: string;
  usageExamples: string | null;
  toolHarness: string;
  categories: string[];
  requesterUserId: string;
  requesterName: string;
  requesterAvatar: string | null;
  createdAt: string;
  /** Present on every row; only "open" or "fulfilled" ever show up here — withdrawn/removed hard-
   *  delete the row (§26), so there's nothing left to list for those. */
  state: "open" | "fulfilled" | "withdrawn" | "removed";
  /** Server-computed: posted since the caller last opened Requested skills (§26) — same "new"
   *  corner tag as the catalog, not re-triggered by editing an already-seen request. Never set in
   *  "Mine" mode (these are the caller's own posts). */
  isNew?: boolean;
}

/** State pill shown only in "Mine" mode (§26) — the org-wide open list is always "open", so the
 *  pill would be redundant noise there. */
function StatePill({ state }: { state: RequestEntry["state"] }) {
  return state === "fulfilled" ? <Pill tone="muted">fulfilled</Pill> : <Pill tone="ok">open</Pill>;
}

/** Same "new" corner tag as the catalog's NewBadge (SkillCard.tsx) — reuses its CSS (chip-new /
 *  has-new are generic, keyed off .skill-card / .skill-row, not skill-specific). */
function NewBadge({ r }: { r: RequestEntry }) {
  const fmt = useDateFmt();
  if (!r.isNew) return null;
  return <span className="chip chip-new" title={`New — asked ${fmt.dateTime(r.createdAt)}`}>new</span>;
}

function RequestCard({ r, index, showState }: { r: RequestEntry; index: number; showState: boolean }) {
  const fmt = useDateFmt();
  return (
    <Link href={`/requests/${r.id}`} className="card skill-card reveal" style={{ animationDelay: `${Math.min(index, 11) * 45}ms` }}>
      {/* Absolutely pinned to the card's top-right corner (see .skill-card > .chip-new). */}
      <NewBadge r={r} />
      {/* Same two-row cap as the catalog card's top meta (§14). */}
      <div className="meta skill-card-top">
        <span className="chip">{agentLabel(r.toolHarness)}</span>
        {showState && <StatePill state={r.state} />}
      </div>
      <h3 title={r.title}>{r.title}</h3>
      <p className="desc" title={descTooltip(r.description)}>{plainText(r.description)}</p>
      {/* Reuses .skill-card, so §14's fixed height applies here too: categories clip to one line
          and the footer must not wrap. No inline flexWrap, or it overrides the nowrap. */}
      <div className="meta skill-card-cats" style={{ marginTop: "auto", paddingTop: 6 }}>
        {r.categories.map((c) => <span key={c} className="chip">{c}</span>)}
      </div>
      <div className="meta skill-card-stats" style={{ paddingTop: 10, borderTop: "1px solid var(--line)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5 }}>
          <UserBubble name={r.requesterName} avatar={r.requesterAvatar} userId={r.requesterUserId} size={20} />
          {r.requesterName}
        </span>
        <span className="muted mono" style={{ marginLeft: "auto", fontSize: 11 }}>asked {fmt.date(r.createdAt)}</span>
      </div>
    </Link>
  );
}

function RequestRow({ r, showState }: { r: RequestEntry; showState: boolean }) {
  const fmt = useDateFmt();
  // .has-new reserves right padding so the full-height edge tab never overlaps row content.
  return (
    <Link href={`/requests/${r.id}`} className={`card skill-row${r.isNew ? " has-new" : ""}`}>
      {/* Absolutely pinned to the row's right edge, spanning full height (see .skill-row > .chip-new). */}
      <NewBadge r={r} />
      <div className="skill-row-id">
        <div style={{ fontWeight: 600, fontSize: 15 }}>{r.title}</div>
        <div className="ns mono" style={{ fontSize: 11.5 }}>{r.requesterName}</div>
      </div>
      <p className="desc muted skill-row-desc">{plainText(r.description)}</p>
      <div className="skill-row-meta">
        {showState && <StatePill state={r.state} />}
        <span className="chip">{agentLabel(r.toolHarness)}</span>
        <span className="skill-row-stats">
          <span className="muted mono" style={{ fontSize: 11, minWidth: 72, textAlign: "right" }}>asked {fmt.date(r.createdAt)}</span>
        </span>
      </div>
    </Link>
  );
}

function RequestsInner() {
  // Search comes from the top-bar box — on /requests it live-filters this list via ?q= (§10), the
  // same way the catalog works. There is no page-local search input; pressing Enter anywhere jumps
  // focus to that box.
  useEnterKey(() => window.dispatchEvent(new Event("skilly:focus-search")));
  const params = useSearchParams();
  const submitted = params.get("q") ?? "";
  const [category, setCategory] = useState<string | null>(null);
  const [tool, setTool] = useState<string | null>(null);
  const [view, setView] = useState<"cards" | "list">("cards");
  // "Mine" (§26): your own requests, any state (open/fulfilled), instead of the org-wide open list.
  const [mine, setMine] = useState(false);
  // Platform-admin state filter (§26): the org-wide list shows OPEN only by default; an admin can
  // switch to Fulfilled or All. Ignored server-side for non-admins. Not applicable in "Mine" mode
  // (Mine already spans every state).
  const [stateFilter, setStateFilter] = useState<"open" | "fulfilled" | "all">("open");
  // The Category row collapses and starts collapsed, the catalog's way (§10/§26). Two states: the
  // effective one, and the persisted preference an auto-expand must never overwrite.
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [categoryOpenPref, setCategoryOpenPref] = useState(false);
  const toggleCategory = () => { const next = !categoryOpen; setCategoryOpen(next); setCategoryOpenPref(next); };

  // This page previously remembered nothing, so a collapsed Category row could not survive a
  // reload. It now carries its own prefs object mirroring the catalog's `skilly.catalogPrefs`
  // (§26) — filters, view, and the collapse flag. Free-text search stays URL-driven (`?q=`) and is
  // never persisted. `prefsLoaded` gates the save so the mount-time defaults can't clobber it.
  const PREFS_KEY = "skilly.requestsPrefs";
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Partial<{ category: string | null; tool: string | null; mine: boolean; stateFilter: "open" | "fulfilled" | "all"; view: "cards" | "list"; categoryOpen: boolean }>;
        if ("category" in p) setCategory(p.category ?? null);
        if ("tool" in p) setTool(p.tool ?? null);
        if (typeof p.mine === "boolean") setMine(p.mine);
        if (p.stateFilter === "open" || p.stateFilter === "fulfilled" || p.stateFilter === "all") setStateFilter(p.stateFilter);
        if (p.view === "cards" || p.view === "list") setView(p.view);
        setCategoryOpenPref(storedFacetRowOpen(p.categoryOpen));
        // Auto-expand (effective state only) so a restored category filter is never invisible.
        setCategoryOpen(initialFacetRowOpen(p.categoryOpen, p.category));
      }
    } catch { /* private mode / bad JSON — fall back to defaults */ }
    setPrefsLoaded(true);
  }, []);
  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ category, tool, mine, stateFilter, view, categoryOpen: categoryOpenPref }));
    } catch { /* private mode etc. */ }
  }, [prefsLoaded, category, tool, mine, stateFilter, view, categoryOpenPref]);

  const qs = new URLSearchParams();
  if (submitted) qs.set("q", submitted);
  if (category) qs.set("category", category);
  if (tool) qs.set("tool", tool);
  if (mine) qs.set("mine", "1");
  else if (stateFilter !== "open") qs.set("state", stateFilter);
  const { data, loading, error } = useApi<{ requests: RequestEntry[]; facets?: RequestFacets; isAdmin?: boolean }>(`/api/requests${qs.toString() ? `?${qs}` : ""}`);
  const requests = data?.requests ?? [];
  const isAdmin = data?.isAdmin ?? false;
  // Show the per-row state pill whenever the list can contain non-open rows: your own list (Mine),
  // or the admin viewing Fulfilled/All.
  const showState = mine || stateFilter !== "open";

  // Facets come from the SERVER now (§26), not from the returned rows: scope-aware (they honour
  // Mine / the state filter) but blind to q/category/tool, so selecting a category can't shrink the
  // vocabulary out from under the pointer — nor make the Category header count read "· 1".
  const categories = data?.facets?.categories ?? [];
  const tools = data?.facets?.tools ?? [];

  return (
    <div>
      <ScrollToTop />
      <div className="page-head reveal">
        <div className="eyebrow">Contribute</div>
        <h1 className="page-title">Requested skills.</h1>
        <p className="page-sub">
          Skills people wish existed. Open one and hit <strong>Propose a skill</strong> to build it — the requester is notified when it ships.
          {" "}Want something yourself? <Link href="/propose" style={{ textDecoration: "underline" }}>Request it</Link> with the “I want a skill” toggle.
        </p>
      </div>

      <div className="reveal" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
        <button type="button" className={`facet${mine ? " facet-on" : ""}`} onClick={() => setMine((m) => !m)} title="Show only your own requests, in any state">
          👤 Mine
        </button>
        {/* Platform-admin state filter (§26): the org-wide list is OPEN only for everyone; an admin
            can also see fulfilled requests. Hidden in Mine mode (that already spans every state). */}
        {isAdmin && !mine && (
          <div className="sort-toggle" role="group" aria-label="Request state">
            {(["open", "fulfilled", "all"] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={`sort-opt${stateFilter === s ? " sort-on" : ""}`}
                onClick={() => setStateFilter(s)}
                title={s === "open" ? "Open requests" : s === "fulfilled" ? "Fulfilled requests" : "All requests"}
              >
                {s === "open" ? "Open" : s === "fulfilled" ? "Fulfilled" : "All"}
              </button>
            ))}
          </div>
        )}
        {(category || tool) && (
          <button className="btn-ghost mono" style={{ fontSize: 12 }} onClick={() => { setCategory(null); setTool(null); }}>✕ clear</button>
        )}
        <span style={{ flex: 1 }} />
        <div className="sort-toggle" role="group" aria-label="View mode">
          <button type="button" className={`sort-opt${view === "cards" ? " sort-on" : ""}`} onClick={() => setView("cards")} title="Card grid">⊞ Cards</button>
          <button type="button" className={`sort-opt${view === "list" ? " sort-on" : ""}`} onClick={() => setView("list")} title="Compact list">☰ List</button>
        </div>
      </div>

      {/* Category / Harness chips sit in their own labelled rows below the toolbar, the catalog's
          way (§26) — the Category row collapsible and collapsed by default, sharing the catalog's
          component so the two pages behave identically. Only Category collapses. */}
      {(categories.length > 0 || tools.length > 0) && (
        <div className="reveal" style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
          {categories.length > 0 && (
            <CollapsibleFacetRow id="requests-category" label="Category" count={categories.length} open={categoryOpen} onToggle={toggleCategory}>
              {categories.map((c) => (
                <button key={c.name} type="button" className={`facet${category === c.name ? " facet-on" : ""}`} onClick={() => setCategory(category === c.name ? null : c.name)}>
                  {c.name} <span className="facet-n">{c.count}</span>
                </button>
              ))}
            </CollapsibleFacetRow>
          )}
          {tools.length > 0 && (
            <FacetRow label="Harness">
              {tools.map((t) => (
                <button key={t.name} type="button" className={`facet${tool === t.name ? " facet-on" : ""}`} onClick={() => setTool(tool === t.name ? null : t.name)}>
                  {agentLabel(t.name)} <span className="facet-n">{t.count}</span>
                </button>
              ))}
            </FacetRow>
          )}
        </div>
      )}

      {error ? (
        <EmptyState icon="⚠" title="Couldn’t load requests" hint={error} />
      ) : loading ? (
        <SkeletonGrid />
      ) : requests.length === 0 ? (
        <EmptyState
          title={
            submitted || category || tool
              ? "No requests match your filters"
              : mine
                ? "You haven’t asked for anything yet"
                : stateFilter === "fulfilled"
                  ? "No fulfilled requests yet"
                  : stateFilter === "all"
                    ? "No requests yet"
                    : "No open requests"
          }
          hint={
            submitted || category || tool
              ? "Try a different search or clear filters."
              : mine
                ? "Propose a skill → “I want a skill” to post one."
                : stateFilter !== "open"
                  ? "Nothing here yet — fulfilled requests appear once a linked proposal is accepted."
                  : "Ask for the skill you wish existed — Propose a skill → “I want a skill”."
          }
        />
      ) : view === "cards" ? (
        <div className="card-grid">
          {requests.map((r, i) => <RequestCard key={r.id} r={r} index={i} showState={showState} />)}
        </div>
      ) : (
        <div className="rows reveal">
          {requests.map((r) => <RequestRow key={r.id} r={r} showState={showState} />)}
        </div>
      )}
    </div>
  );
}

export default function RequestsPage() {
  return (
    <RequireAuth>
      <Suspense fallback={<SkeletonGrid />}>
        <RequestsInner />
      </Suspense>
    </RequireAuth>
  );
}
