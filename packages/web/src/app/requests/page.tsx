"use client";
// Requested skills (§26): open skill requests, in the catalog's card/row language. Org-visible.
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useApi, useEnterKey, SkeletonGrid, EmptyState, ScrollToTop, Pill } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { UserBubble } from "../../components/UserBubble";
import { useDateFmt } from "../../components/DateFormat";
import { agentLabel } from "@skilly/shared/agents";

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

/** Markdown → clamped plain-text preview (same treatment as catalog cards). */
function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function RequestCard({ r, index, showState }: { r: RequestEntry; index: number; showState: boolean }) {
  const fmt = useDateFmt();
  return (
    <Link href={`/requests/${r.id}`} className="card skill-card reveal" style={{ animationDelay: `${Math.min(index, 11) * 45}ms` }}>
      {/* Absolutely pinned to the card's top-right corner (see .skill-card > .chip-new). */}
      <NewBadge r={r} />
      <div className="meta">
        <span className="chip">{agentLabel(r.toolHarness)}</span>
        {showState && <StatePill state={r.state} />}
      </div>
      <h3>{r.title}</h3>
      <p className="desc">{plainText(r.description)}</p>
      <div className="meta" style={{ marginTop: "auto", paddingTop: 6, flexWrap: "wrap" }}>
        {r.categories.map((c) => <span key={c} className="chip">{c}</span>)}
      </div>
      <div className="meta" style={{ paddingTop: 10, borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
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

  const qs = new URLSearchParams();
  if (submitted) qs.set("q", submitted);
  if (category) qs.set("category", category);
  if (tool) qs.set("tool", tool);
  if (mine) qs.set("mine", "1");
  else if (stateFilter !== "open") qs.set("state", stateFilter);
  const { data, loading, error } = useApi<{ requests: RequestEntry[]; isAdmin?: boolean }>(`/api/requests${qs.toString() ? `?${qs}` : ""}`);
  const requests = data?.requests ?? [];
  const isAdmin = data?.isAdmin ?? false;
  // Show the per-row state pill whenever the list can contain non-open rows: your own list (Mine),
  // or the admin viewing Fulfilled/All.
  const showState = mine || stateFilter !== "open";

  // Facets derived from the returned set (requests are a small, org-visible list).
  const categories = [...new Set(requests.flatMap((r) => r.categories))].sort();
  const tools = [...new Set(requests.map((r) => r.toolHarness))].sort();

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
        {categories.length > 1 && categories.map((c) => (
          <button key={c} type="button" className={`facet${category === c ? " facet-on" : ""}`} onClick={() => setCategory(category === c ? null : c)}>{c}</button>
        ))}
        {tools.length > 1 && tools.map((t) => (
          <button key={t} type="button" className={`facet${tool === t ? " facet-on" : ""}`} onClick={() => setTool(tool === t ? null : t)}>{agentLabel(t)}</button>
        ))}
        {(category || tool) && (
          <button className="btn-ghost mono" style={{ fontSize: 12 }} onClick={() => { setCategory(null); setTool(null); }}>✕ clear</button>
        )}
        <span style={{ flex: 1 }} />
        <div className="sort-toggle" role="group" aria-label="View mode">
          <button type="button" className={`sort-opt${view === "cards" ? " sort-on" : ""}`} onClick={() => setView("cards")} title="Card grid">⊞ Cards</button>
          <button type="button" className={`sort-opt${view === "list" ? " sort-on" : ""}`} onClick={() => setView("list")} title="Compact list">☰ List</button>
        </div>
      </div>

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
