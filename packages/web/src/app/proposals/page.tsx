"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useApi, useEnterKey, Pill, EmptyState, ScrollToTop } from "../../components/ui";
import { RequireAuth } from "../../components/RequireAuth";
import { useDateFmt } from "../../components/DateFormat";

type ProposalState = "proposed" | "under_review" | "changes_requested" | "accepted" | "rejected";
type Tab = "review" | "mine";

interface ProposalRow {
  id: string;
  state: ProposalState;
  proposedSemver: string;
  isNewSkill: boolean;
  namespaceSlug: string;
  skillSlug: string | null;
  title: string | null;
  createdAt: string;
  submittedBy: string;
}
// Initial GET: the caller's own submissions (whole) + whether the review tab is shown.
interface MetaResponse { mine: ProposalRow[]; canReview: boolean }
// `?tab=review` GET: one paginated batch of the reviewer queue, newest-first (§8).
interface ReviewPage {
  items: ProposalRow[];
  nextCursor: string | null;
  counts: Partial<Record<ProposalState, number>>;
  total: number;
}

const STATE_TONE: Record<string, "ok" | "warn" | "danger" | "muted"> = {
  proposed: "muted",
  under_review: "warn",
  changes_requested: "warn",
  accepted: "ok",
  rejected: "danger",
};

// Filter chips, in lifecycle order. Label-cased for display; value is the raw state.
const STATE_FILTERS: { value: ProposalState; label: string }[] = [
  { value: "proposed", label: "Proposed" },
  { value: "under_review", label: "Under review" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
];

function ProposalsInner() {
  const router = useRouter();
  const fmt = useDateFmt();
  const { data: meta, loading, error } = useApi<MetaResponse>("/api/proposals");
  const canReview = meta?.canReview ?? false;
  const mine = meta?.mine ?? [];

  // Which list is active. Null until the first load resolves, so we can default to the caller's
  // action-relevant tab (reviewers → "To review", everyone else → "Mine"). §8.
  const [tab, setTab] = useState<Tab | null>(null);
  // Per-tab default state filter (catalog-style chips). Review opens to the three OPEN states
  // (Proposed + Under review + Changes requested) — everything still in flight; Mine opens with
  // NO filter selected (all your submissions, every state).
  const [states, setStates] = useState<Set<ProposalState>>(new Set());
  const defaultStates = (t: Tab): Set<ProposalState> =>
    new Set<ProposalState>(t === "review" ? ["proposed", "under_review", "changes_requested"] : []);
  useEffect(() => {
    if (!meta || tab !== null) return;
    const t: Tab = meta.canReview ? "review" : "mine";
    setTab(t);
    setStates(defaultStates(t));
  }, [meta, tab]);

  // Review queue is paginated server-side (newest-first, 100/batch). We keep the accumulated rows,
  // the next-batch cursor, and the per-state totals (for the chips + tab badge) in local state.
  const [reviewItems, setReviewItems] = useState<ProposalRow[]>([]);
  const [reviewCursor, setReviewCursor] = useState<string | null>(null);
  const [reviewCounts, setReviewCounts] = useState<Partial<Record<ProposalState, number>>>({});
  const [reviewTotal, setReviewTotal] = useState(0);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const reqRef = useRef(0); // guards against out-of-order responses when the filter changes fast

  const fetchReview = useCallback(async (cursor: string | null, stateSet: Set<ProposalState>) => {
    const myReq = ++reqRef.current;
    setReviewLoading(true);
    setReviewError(null);
    try {
      const sp = new URLSearchParams({ tab: "review" });
      if (stateSet.size) sp.set("states", [...stateSet].join(","));
      if (cursor) sp.set("cursor", cursor);
      const r = await fetch(`/api/proposals?${sp.toString()}`);
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
      const { review } = (await r.json()) as { review: ReviewPage };
      if (myReq !== reqRef.current) return; // a newer request superseded this one
      setReviewItems((prev) => (cursor ? [...prev, ...review.items] : review.items));
      setReviewCursor(review.nextCursor);
      setReviewCounts(review.counts);
      setReviewTotal(review.total);
    } catch (e) {
      if (myReq !== reqRef.current) return;
      setReviewError(e instanceof Error ? e.message : String(e));
    } finally {
      if (myReq === reqRef.current) setReviewLoading(false);
    }
  }, []);

  // (Re)load the first batch whenever the review tab is active and the state filter changes.
  useEffect(() => {
    if (tab !== "review" || !canReview) return;
    setReviewItems([]);
    setReviewCursor(null);
    fetchReview(null, states);
  }, [tab, states, canReview, fetchReview]);

  const loadMore = useCallback(() => {
    if (tab !== "review" || reviewLoading || !reviewCursor) return;
    fetchReview(reviewCursor, states);
  }, [tab, reviewLoading, reviewCursor, states, fetchReview]);

  // Reviewer housekeeping: permanently delete a queue proposal (spam/dupes/test/mistakes). Silent +
  // audited server-side; a 404 (already gone) is treated as success. On success we drop the row and
  // decrement the per-state count + tab total so the chips/badge stay honest without a refetch. §8.
  const removeProposal = useCallback(async (p: ProposalRow) => {
    if (!window.confirm(
      `Permanently delete this proposal — ${p.title ?? p.skillSlug ?? "untitled"} v${p.proposedSemver}?\n\n` +
      "This removes the proposal, its revisions, and its review discussion. The audit record is kept. This can't be undone.",
    )) return;
    setDeletingId(p.id);
    try {
      const r = await fetch(`/api/proposals/${p.id}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) {
        throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Delete failed (${r.status})`);
      }
      setReviewItems((prev) => prev.filter((x) => x.id !== p.id));
      setReviewCounts((prev) => ({ ...prev, [p.state]: Math.max(0, (prev[p.state] ?? 0) - 1) }));
      setReviewTotal((prev) => Math.max(0, prev - 1));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingId(null);
    }
  }, []);

  // Infinite scroll: fetch the next batch as a sentinel near the bottom scrolls into view.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (tab !== "review" || !reviewCursor) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) loadMore(); },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [tab, reviewCursor, loadMore]);

  // The visible list. Review is already server-filtered + server-ordered (newest-first); Mine is the
  // full personal list, ordered newest-first by the API and filtered client-side.
  const proposals =
    tab === "review" ? reviewItems : states.size === 0 ? mine : mine.filter((p) => states.has(p.state));

  // Press Enter to open the first actionable proposal (first review 'proposed', or your first
  // 'changes_requested') in the active tab.
  useEnterKey(() => {
    const want: ProposalState = tab === "review" ? "proposed" : "changes_requested";
    const first = proposals.find((p) => p.state === want) ?? proposals[0];
    if (first) router.push(`/proposals/${first.id}`);
  });
  const toggle = (s: ProposalState) =>
    setStates((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  const switchTab = (t: Tab) => {
    setTab(t);
    setStates(defaultStates(t));
  };

  // Chip counts + "has anything" come from the server totals on the review tab (so they reflect the
  // whole backlog, not just the rows scrolled into view) and from the loaded list on the mine tab.
  const chipCount = (s: ProposalState) => (tab === "review" ? reviewCounts[s] ?? 0 : mine.filter((p) => p.state === s).length);
  const hasAny = tab === "review" ? reviewTotal > 0 : mine.length > 0;
  const reviewInitialLoading = tab === "review" && reviewLoading && reviewItems.length === 0;

  return (
    <div>
      <ScrollToTop />
      <div className="page-head reveal">
        <div className="eyebrow">Governance</div>
        <h1 className="page-title">Proposals.</h1>
        <p className="page-sub">
          {tab === "review"
            ? "Proposals in the namespaces you administer, newest first. Filter by one or more states below."
            : "Skills you've submitted. Resubmit the ones that need changes; filter by state below."}
        </p>
      </div>

      {/* Tabs: "Mine" for everyone; "To review" only when you have review authority. */}
      {!loading && !error && canReview && (
        <div className="tabs" style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button type="button" className={`btn btn-sm${tab === "review" ? " btn-primary" : ""}`} aria-pressed={tab === "review"} onClick={() => switchTab("review")}>
            To review <span className="facet-n">{reviewTotal}</span>
          </button>
          <button type="button" className={`btn btn-sm${tab === "mine" ? " btn-primary" : ""}`} aria-pressed={tab === "mine"} onClick={() => switchTab("mine")}>
            My submissions <span className="facet-n">{mine.length}</span>
          </button>
        </div>
      )}

      {!loading && !error && hasAny && (
        <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap", alignItems: "center" }}>
          {STATE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`facet${states.has(f.value) ? " facet-on" : ""}`}
              aria-pressed={states.has(f.value)}
              onClick={() => toggle(f.value)}
            >
              {f.label} <span className="facet-n">{chipCount(f.value)}</span>
            </button>
          ))}
          {states.size > 0 && (
            <button className="btn-ghost mono" style={{ fontSize: 12 }} onClick={() => setStates(new Set())}>
              ✕ clear
            </button>
          )}
        </div>
      )}

      {error ? (
        <EmptyState icon="⚠" title="Couldn’t load proposals" hint={error} />
      ) : loading || reviewInitialLoading ? (
        <div className="rows">
          {Array.from({ length: 4 }).map((_, i) => (
            <div className="row" key={i}><div className="skeleton" style={{ height: 16, width: "40%" }} /></div>
          ))}
        </div>
      ) : tab === "review" && reviewError ? (
        <EmptyState icon="⚠" title="Couldn’t load the review queue" hint={reviewError} />
      ) : proposals.length === 0 ? (
        states.size > 0
          ? <EmptyState title="No proposals in the selected states" hint="Adjust the filters above or clear the selection." />
          : tab === "review"
            ? <EmptyState title="Queue is clear" hint="No proposals are waiting on you right now." />
            : <EmptyState title="No submissions yet" hint="Propose a skill from the catalog and it'll show up here." />
      ) : (
        <>
          <div className="rows reveal">
            {proposals.map((p) => (
              <Link href={`/proposals/${p.id}`} className="row" key={p.id}>
                <div className="grow">
                  <div className="ttl">{p.title ?? p.skillSlug ?? "Untitled skill"}</div>
                  <div className="sub mono" style={{ fontSize: 11 }}>
                    @{p.namespaceSlug}{p.skillSlug ? `/${p.skillSlug}` : ""} · {p.isNewSkill ? "new skill" : "new version"} · v{p.proposedSemver}
                  </div>
                  <div className="sub" style={{ fontSize: 11.5, color: "var(--faint)" }}>
                    {tab === "mine" ? "submitted" : `proposed by ${p.submittedBy}`} · <span className="mono">{fmt.dateTime(p.createdAt)}</span>
                  </div>
                </div>
                <Pill tone={STATE_TONE[p.state]}>{p.state.replace("_", " ")}</Pill>
                {/* Reviewer-only housekeeping delete. Hidden for accepted (locked server-side —
                    provenance of a live version). Sibling button: isolate its click from the row link. */}
                {tab === "review" && p.state !== "accepted" && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    title="Delete this proposal (permanent)"
                    aria-label="Delete proposal"
                    disabled={deletingId === p.id}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); void removeProposal(p); }}
                  >
                    {deletingId === p.id ? "…" : "✕"}
                  </button>
                )}
                <span style={{ color: "var(--faint)" }}>→</span>
              </Link>
            ))}
          </div>
          {/* Infinite-scroll sentinel + "loading more" line for the review queue. */}
          {tab === "review" && reviewCursor && (
            <div ref={sentinelRef} style={{ padding: "16px 0", textAlign: "center", color: "var(--faint)", fontSize: 12 }}>
              {reviewLoading ? "Loading more…" : ""}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function ProposalsPage() {
  return (
    <RequireAuth>
      <ProposalsInner />
    </RequireAuth>
  );
}
