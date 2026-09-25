"use client";
// Survey results — item 6 of the Monitoring page (SKILLY_SPEC.md §36.9). A collapsible card,
// collapsed by default, with the platform on/off switch in its header (§36.8). It follows the page's
// range toggle, renders regardless of RUM, loads on first expand, then on range / filter change and
// on the page's Refresh — never polled. Figures over fewer than 5 responses arrive withheld.
import { useCallback, useEffect, useState } from "react";
import nextDynamic from "next/dynamic";
import { EmptyState, Switch } from "../../../components/ui";
import { useDateFmt } from "../../../components/DateFormat";
import { readPref, writePref, adminCardPrefKey } from "../../../lib/prefs";
import { CollapsibleCard } from "../CollapsibleCard";
import { SURVEY_MIN_GROUP, surveyFeatureLabel, type SurveySegment, type SurveySource, type SurveyTrigger } from "@skilly/shared/survey";

const SurveyChart = nextDynamic(() => import("./SurveyChart").then((m) => m.SurveyChart), {
  ssr: false,
  loading: () => <div className="skeleton" style={{ height: 200, borderRadius: "var(--radius)" }} />,
});

type Range = 7 | 30 | 90 | "all";

interface QuestionStat {
  key: string;
  text: string;
  retired: boolean;
  n: number | null;
  avg: number | null;
  distribution: number[] | null;
  withheld: boolean;
}
interface Summary {
  enabled: boolean;
  lastDate: string | null;
  bucket: "day" | "week" | "month";
  responses: number;
  funnel: { shown: number; closed: number; submitted: number; submittedFromMenu: number; optedOut: number; shownSelf: number; submittedSelf: number };
  series: { date: string; n: number | null; overallAvg: number | null; withheld: boolean }[];
  questions: QuestionStat[];
  features: { key: string; label: string; n: number | null }[];
}
interface Comment {
  id: string;
  answeredOn: string;
  feature: string | null;
  segment: SurveySegment;
  trigger: SurveyTrigger;
  text: string;
}

const WITHHELD = `Not enough responses yet (fewer than ${SURVEY_MIN_GROUP}).`;
const SEGMENTS: { key: SurveySegment | null; label: string }[] = [
  { key: null, label: "All" },
  { key: "consumer", label: "Consumer" },
  { key: "maintainer", label: "Maintainer" },
  { key: "admin", label: "Admin" },
];
// §36.16 the Source filter: random prompts vs on-demand ("Give feedback now").
const SOURCES: { key: SurveySource | null; label: string }[] = [
  { key: null, label: "All" },
  { key: "prompted", label: "Prompted" },
  { key: "self", label: "Self-initiated" },
];
const segmentLabel = (s: SurveySegment) => SEGMENTS.find((x) => x.key === s)?.label ?? s;
const CARD_KEY = adminCardPrefKey("survey");

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Request failed (${r.status})`);
  return r.json() as Promise<T>;
}

export function SurveyResults({ range, refreshTick }: { range: Range; refreshTick: number }) {
  const fmt = useDateFmt();
  // Collapsed by default; the stored state is read after mount (lib/prefs.ts, hydration-safe).
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => { setOpen(readPref(CARD_KEY, "0") === "1"); }, []);
  const toggle = () => setOpen((o) => { const next = !o; writePref(CARD_KEY, next ? "1" : "0"); return next; });

  const [segment, setSegment] = useState<SurveySegment | null>(null);
  const [feature, setFeature] = useState<string | null>(null);
  const [source, setSource] = useState<SurveySource | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsTotal, setCommentsTotal] = useState(0);
  const [commentsWithheld, setCommentsWithheld] = useState(false);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  // Loads only once the card has been opened (first expand), then follows range / filter / refresh.
  const [loadedOnce, setLoadedOnce] = useState(false);
  useEffect(() => { if (open) setLoadedOnce(true); }, [open]);

  const qs = useCallback(() => {
    const p = new URLSearchParams({ range: String(range) });
    if (segment) p.set("segment", segment);
    if (feature) p.set("feature", feature);
    if (source) p.set("source", source);
    return p.toString();
  }, [range, segment, feature, source]);

  // The header summary + switch need the summary even while collapsed, so it loads on mount too.
  useEffect(() => {
    let live = true;
    setError(null);
    getJson<Summary>(`/api/admin/survey/summary?${qs()}`)
      .then((j) => { if (live) setSummary(j); })
      .catch((e) => { if (live) setError(String((e as Error).message ?? e)); });
    return () => { live = false; };
  }, [qs, refreshTick, tick]);

  const loadComments = useCallback(async (offset: number) => {
    setCommentsLoading(true);
    try {
      const j = await getJson<{ comments: Comment[]; total: number; withheld: boolean }>(`/api/admin/survey/comments?${qs()}&offset=${offset}&limit=50`);
      setComments((prev) => (offset === 0 ? j.comments : [...prev, ...j.comments]));
      setCommentsTotal(j.total);
      setCommentsWithheld(j.withheld);
    } catch {
      /* the feed is secondary; the summary surfaces errors */
    } finally {
      setCommentsLoading(false);
    }
  }, [qs]);
  useEffect(() => {
    if (!loadedOnce) return;
    void loadComments(0);
  }, [loadedOnce, loadComments, refreshTick, tick]);

  const setEnabled = async (next: boolean) => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyEnabled: next }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Failed (${r.status})`);
      setTick((t) => t + 1);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/survey/responses/${id}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) throw new Error((await r.json().catch(() => ({}))).error ?? `Failed (${r.status})`);
      setConfirming(null);
      setTick((t) => t + 1);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  if (open === null) return <div className="skeleton" style={{ height: 58, borderRadius: "var(--radius)", marginBottom: 26 }} />;

  const f = summary?.funnel;
  const rate = f && f.shown > 0 ? Math.round((f.submitted / f.shown) * 100) : null;
  const empty = !!summary && summary.responses === 0 && (f?.shown ?? 0) === 0 && (f?.shownSelf ?? 0) === 0;
  const general = summary?.questions.filter((q) => !q.key.startsWith("feature.")) ?? [];
  const featureQs = summary?.questions.filter((q) => q.key.startsWith("feature.")) ?? [];

  return (
    <div data-testid="survey-results">
      <CollapsibleCard
        cardId="survey"
        title="Survey results"
        summary={summary ? `${summary.responses} ${summary.responses === 1 ? "response" : "responses"} in range` : undefined}
        action={
          <Switch
            label="Ask users"
            checked={summary?.enabled ?? true}
            disabled={busy || !summary}
            onChange={(next) => void setEnabled(next)}
            title="Off: no user is offered a survey; collected results stay visible."
          />
        }
        open={open}
        onToggle={toggle}
      >
        {error && <div className="muted" style={{ fontSize: 13, color: "var(--danger)", marginBottom: 12 }}>{error}</div>}
        {summary && !summary.enabled && (
          <div className="muted" role="status" style={{ marginBottom: 14, fontSize: 13, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: "var(--radius)" }}>
            Surveys are off. Showing responses collected until {summary.lastDate ? fmt.date(`${summary.lastDate}T12:00:00Z`) : "—"}.
          </div>
        )}
        {!summary ? (
          <div className="skeleton" style={{ height: 160, borderRadius: "var(--radius)" }} />
        ) : empty ? (
          <EmptyState title="No responses yet" hint="Responses appear here as people answer the survey." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            {/* 1. Funnel — range-bound, unfiltered. */}
            <div className="survey-funnel" data-testid="survey-funnel">
              <Figure label="Shown" value={f!.shown} />
              <Figure label="Closed on sight" value={f!.closed} />
              <Figure label="Submitted" value={f!.submitted} hint={f!.submittedFromMenu > 0 ? `${f!.submittedFromMenu} later, from the menu` : undefined} />
              <Figure label="Response rate" value={rate == null ? "—" : `${rate} %`} />
              <Figure label="Opted out" value={f!.optedOut} hint="current, not range-bound" />
            </div>
            {/* §36.16 on-demand surveys, counted apart so the response rate stays about random prompts. */}
            <div className="muted" style={{ fontSize: 13, marginTop: -12 }} data-testid="survey-funnel-self">
              Self-initiated: {f!.shownSelf.toLocaleString()} opened · {f!.submittedSelf.toLocaleString()} submitted
            </div>

            {/* Filters — apply to the stats, the trend and the feed. */}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <div className="sort-toggle" role="group" aria-label="Segment">
                {SEGMENTS.map((s) => (
                  <button key={s.label} type="button" className={`sort-opt${segment === s.key ? " sort-on" : ""}`} onClick={() => setSegment(s.key)}>
                    {s.label}
                  </button>
                ))}
              </div>
              <div className="sort-toggle" role="group" aria-label="Source">
                {SOURCES.map((s) => (
                  <button key={s.label} type="button" className={`sort-opt${source === s.key ? " sort-on" : ""}`} onClick={() => setSource(s.key)}>
                    {s.label}
                  </button>
                ))}
              </div>
              <div className="select-wrap" style={{ width: 230 }}>
                <select
                  aria-label="Feature"
                  value={feature ?? ""}
                  onChange={(e) => setFeature(e.target.value || null)}
                  style={{ width: "100%", padding: "8px 38px 8px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontSize: 13 }}
                >
                  <option value="">All features</option>
                  {summary.features.map((x) => (
                    <option key={x.key} value={x.key}>{x.label}</option>
                  ))}
                  {feature && !summary.features.some((x) => x.key === feature) && <option value={feature}>{surveyFeatureLabel(feature)}</option>}
                </select>
                <svg className="select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </div>
            </div>

            {/* 2. Trend. */}
            <div>
              <div className="muted mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                Overall satisfaction · {summary.bucket === "day" ? "daily" : summary.bucket === "week" ? "weekly" : "monthly"}
              </div>
              {summary.series.every((p) => p.withheld) ? (
                <div className="muted" style={{ fontSize: 13 }}>{WITHHELD}</div>
              ) : (
                <SurveyChart points={summary.series} bucket={summary.bucket} />
              )}
            </div>

            {/* 3. Question cards. */}
            {summary.questions.length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>No star answers in this selection.</div>
            ) : (
              <div className="survey-stats" data-testid="survey-questions">
                {[...general, ...featureQs].map((q) => <QuestionCard key={q.key} q={q} />)}
              </div>
            )}

            {/* 4. Free-text feed. */}
            <div>
              <div className="muted mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                Comments{commentsWithheld ? "" : ` · ${commentsTotal}`}
              </div>
              {commentsWithheld ? (
                <div className="muted" style={{ fontSize: 13 }} data-testid="survey-comments-withheld">{WITHHELD}</div>
              ) : comments.length === 0 ? (
                <div className="muted" style={{ fontSize: 13 }}>{commentsLoading ? "Loading…" : "No comments in this selection."}</div>
              ) : (
                <div className="rows" data-testid="survey-comments">
                  {comments.map((c) => (
                    <div className="row" key={c.id} style={{ alignItems: "flex-start" }} data-testid="survey-comment">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{c.text}</div>
                        <div className="sub" style={{ fontSize: 11.5, marginTop: 4 }}>
                          {fmt.date(`${c.answeredOn}T12:00:00Z`)} · {c.feature ? surveyFeatureLabel(c.feature) : "General"} · {segmentLabel(c.segment)}
                          {c.trigger === "self" && <span className="chip" style={{ marginLeft: 6 }}>Self-initiated</span>}
                        </div>
                      </div>
                      {confirming === c.id ? (
                        <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                          <span className="muted" style={{ fontSize: 12 }}>Delete this response? Its star answers are removed too.</span>
                          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void remove(c.id)}>Delete</button>
                          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
                        </div>
                      ) : (
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirming(c.id)} aria-label="Delete response">Delete</button>
                      )}
                    </div>
                  ))}
                  {comments.length < commentsTotal && (
                    <div style={{ padding: "10px 14px" }}>
                      <button type="button" className="btn btn-sm" disabled={commentsLoading} onClick={() => void loadComments(comments.length)}>Show more</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </CollapsibleCard>
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div>
      <div className="survey-funnel-n">{typeof value === "number" ? value.toLocaleString() : value}</div>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      {hint && <div className="sub" style={{ fontSize: 11 }}>{hint}</div>}
    </div>
  );
}

function QuestionCard({ q }: { q: QuestionStat }) {
  const max = q.distribution ? Math.max(1, ...q.distribution) : 1;
  return (
    <div className="survey-stat" data-question={q.key}>
      <div className="survey-stat-head">
        <div style={{ fontSize: 13, minWidth: 0 }}>
          {q.text}
          {q.retired && <span className="chip" style={{ marginLeft: 6 }}>retired</span>}
        </div>
        {!q.withheld && <div className="survey-stat-avg" title={`${q.n} answers`}>{q.avg?.toFixed(1)} ★</div>}
      </div>
      {q.withheld || !q.distribution ? (
        <div className="muted" style={{ fontSize: 12 }}>{WITHHELD}</div>
      ) : (
        <>
          <div className="rating-hist">
            {[5, 4, 3, 2, 1].map((star) => (
              <div className="rating-hist-row" key={star}>
                <span className="rating-hist-label">{star}★</span>
                <span className="rating-hist-track"><span className="rating-hist-fill" style={{ width: `${((q.distribution![star - 1] ?? 0) / max) * 100}%` }} /></span>
                <span className="rating-hist-n">{q.distribution![star - 1] ?? 0}</span>
              </div>
            ))}
          </div>
          <div className="sub mono" style={{ fontSize: 11 }}>n = {q.n}</div>
        </>
      )}
    </div>
  );
}
