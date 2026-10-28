"use client";
import { useEffect, useRef, useState } from "react";
import {
  QUALITY_DIMENSIONS, QUALITY_DIMENSION_LABELS, formatStars, qualityModeLine,
  type QualityAiStatus, type QualityMode, type QualityVerdict,
} from "@skilly/shared/quality";
import { QualityBadge, QualityStars } from "../../../../components/QualityBadge";
import { QualityFindingsList, type QualityFindingItem } from "../../../../components/QualityFindingsList";
import { useAiName } from "../../../../components/AiName";
import { PREF_QUALITY_CARD_OPEN, readPref, removePref, writePref } from "../../../../lib/prefs";
import { QUALITY_HASH, initialQualityCardOpen } from "../../../../lib/qualityCard";
import { AiDraftDialog } from "./AiDraftDialog";

/** §44.2 why the draft action is disabled; null reason with available:false = hidden. */
const DRAFT_DISABLED_TEXT: Record<string, string> = {
  quality_pending: "The quality check for this version is still running — try again shortly.",
  nothing_to_draft: "Nothing to improve — the latest version has no quality findings or suggestions.",
  secret_in_skill_md: "SKILL.md contains a flagged secret — fix it by hand first.",
};

export interface QualityDetailView {
  semver: string;
  ruleset: number;
  rulesScore: number;
  aiStatus: QualityAiStatus;
  aiScore: number | null;
  aiModel: string | null;
  finalScore: number;
  stars: number;
  mode: QualityMode;
  scoredAt: string;
  findings: QualityFindingItem[];
  verdict: QualityVerdict | null;
  canReassess: boolean;
  /** §44.2: whether the viewer may draft improvements with AI. */
  aiDraft?: { available: boolean; reason: string | null };
}

/**
 * The skill page's Quality card (§41.7): stars + score, the mode line, the findings grouped by
 * level, and — when present — the AI assessment (five dimensions, summary, suggestions). Everyone
 * who can see the skill sees all of it. The Re-assess button is for §4 override holders.
 *
 * Collapsible, collapsed by default, with one GLOBAL preference for every skill's card
 * (`skilly.qualityCardOpen`). While collapsed the header carries the compact score; the Draft and
 * Re-assess buttons stay in the header and work either way. A `#quality` deep link opens the card
 * for that view without touching the preference.
 */
export function QualityCard({ detail, base, ns, slug, onChanged }: { detail: QualityDetailView | null; base: string; ns: string; slug: string; onChanged: () => void }) {
  const aiName = useAiName();
  // Client-only state: start collapsed (the server render and first paint) and settle on mount.
  const [open, setOpen] = useState(false);
  const [settled, setSettled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showFindings, setShowFindings] = useState(true);
  const [drafting, setDrafting] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const draft = detail?.aiDraft;
  const draftShown = !!draft && (draft.available || !!draft.reason);

  useEffect(() => {
    const hash = window.location.hash;
    setOpen(initialQualityCardOpen(readPref(PREF_QUALITY_CARD_OPEN, ""), hash));
    if (hash === QUALITY_HASH) window.setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  }, []);
  useEffect(() => {
    if (!open) { setSettled(false); return; }
    const t = window.setTimeout(() => setSettled(true), 220);
    return () => window.clearTimeout(t);
  }, [open]);

  // §44.6: `?draft=ai` (the notification / My Skills link) opens the dialog when the action is enabled.
  useEffect(() => {
    if (!detail || typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("draft") !== "ai") return;
    if (draft?.available) setDrafting(true);
    else setErr(draft?.reason ? DRAFT_DISABLED_TEXT[draft.reason] ?? draft.reason : `Drafting with ${aiName} isn’t available for this skill.`);
    sp.delete("draft");
    const q = sp.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the detail first arrives
  }, [!!detail]);

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      // The one global preference: expanding any skill's card remembers it; collapsing clears it.
      if (next) writePref(PREF_QUALITY_CARD_OPEN, "1");
      else removePref(PREF_QUALITY_CARD_OPEN);
      return next;
    });
  };

  const reassess = async () => {
    if (!detail) return;
    if (!confirm(`This re-runs the rules and, if ${aiName} is on, sends the SKILL.md to ${aiName} again.`)) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${base}/versions/${encodeURIComponent(detail.semver)}/quality/reassess`, { method: "POST" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      onChanged();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const bodyId = "skill-quality-body";
  const hasActions = draftShown || !!detail?.canReassess;
  return (
    <section ref={cardRef} id="quality" className="card" style={{ marginTop: 20, scrollMarginTop: 80 }} data-testid="quality-card">
      <div className="admin-card-headrow quality-card-headrow">
        <button type="button" className="admin-card-head" onClick={toggle} aria-expanded={open} aria-controls={bodyId} data-testid="quality-toggle">
          <h2 className="admin-card-title" style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>Quality</h2>
          {detail && <span className="muted mono" style={{ fontSize: 11 }}>v{detail.semver} · ruleset {detail.ruleset}</span>}
          {!open && (
            <span className="admin-card-summary muted mono quality-card-summary" data-testid="quality-summary">
              {detail ? (
                <>
                  <QualityBadge quality={{ score: detail.finalScore, stars: detail.stars, mode: detail.mode }} />
                  <span>· {detail.finalScore} / 100</span>
                </>
              ) : "pending"}
            </span>
          )}
        </button>
        {hasActions && (
          <span className="admin-card-action quality-card-actions">
            {draftShown && (
              <button
                className="btn btn-sm"
                disabled={!draft!.available}
                title={draft!.available ? undefined : DRAFT_DISABLED_TEXT[draft!.reason ?? ""] ?? undefined}
                onClick={() => setDrafting(true)}
                data-testid="quality-ai-draft"
              >
                ✦ Draft improvements with {aiName}
              </button>
            )}
            {detail?.canReassess && (
              <button className="btn btn-sm" disabled={busy} onClick={reassess} data-testid="quality-reassess">
                {busy ? "re-assessing…" : "re-assess"}
              </button>
            )}
          </span>
        )}
        {/* A second, hidden toggle target so the chevron stays clickable beside the buttons. */}
        <button type="button" className="admin-card-chevron-btn" onClick={toggle} aria-hidden tabIndex={-1}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="admin-card-chevron" data-open={open}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>
      {/* Under the header, not in the body, so an action error shows collapsed or expanded. */}
      {err && <div style={{ color: "var(--danger)", fontSize: 13, padding: "0 22px 14px" }} data-testid="quality-error">{err}</div>}
      <div className="admin-card-body" data-open={open} data-settled={settled} id={bodyId} role="region" aria-hidden={!open}>
        <div className="admin-card-body-inner">
          <div className="admin-card-body-pad">
            {!detail ? (
              <p className="muted" style={{ fontSize: 14, margin: 0 }} data-testid="quality-pending">Quality check pending — the system scores each published version shortly after it lands.</p>
            ) : (
              <>
                <p className="muted" style={{ fontSize: 13.5, marginTop: 0, marginBottom: 14 }} data-testid="quality-mode">{qualityModeLine(detail.mode, detail.aiStatus, detail.aiModel, aiName)}</p>
                <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
                  <div style={{ fontFamily: "var(--font-display)", fontSize: 44, lineHeight: 1 }} data-testid="quality-stars-value">{formatStars(detail.stars)}</div>
                  <div>
                    <QualityStars stars={detail.stars} size={22} />
                    <div className="muted mono" style={{ fontSize: 11.5, marginTop: 4 }} data-testid="quality-score">
                      {detail.finalScore} / 100
                      {detail.mode === "rules+ai" && detail.aiScore !== null ? ` · rules ${detail.rulesScore} · ${aiName} ${detail.aiScore}` : ""}
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <div className="nav-label" style={{ padding: 0 }}>Findings · {detail.findings.length}</div>
                  {detail.findings.length > 0 && (
                    <button type="button" className="btn-ghost mono" style={{ fontSize: 11 }} aria-expanded={showFindings} onClick={() => setShowFindings((s) => !s)}>
                      {showFindings ? "▾ hide" : "▸ show"}
                    </button>
                  )}
                </div>
                {showFindings && <QualityFindingsList findings={detail.findings} />}

                {detail.verdict && (
                  <div style={{ marginTop: 18 }} data-testid="quality-ai">
                    <div className="nav-label" style={{ padding: "0 0 8px" }}>{aiName} assessment</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                      {QUALITY_DIMENSIONS.map((d) => {
                        const dim = detail.verdict!.dimensions[d];
                        return (
                          <div key={d} className="quality-dim">
                            <span className="quality-dim-label">{QUALITY_DIMENSION_LABELS[d]}</span>
                            <span className="quality-dim-track"><span className="quality-dim-fill" style={{ width: `${dim.score}%` }} /></span>
                            <span className="quality-dim-n mono">{dim.score}</span>
                            {dim.remark && <span className="quality-dim-remark muted">{dim.remark}</span>}
                          </div>
                        );
                      })}
                    </div>
                    {detail.verdict.summary && <p style={{ fontSize: 13.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{detail.verdict.summary}</p>}
                    {detail.verdict.suggestions.length > 0 && (
                      <ol style={{ fontSize: 13.5, lineHeight: 1.5, paddingLeft: 20, margin: 0 }} data-testid="quality-suggestions">
                        {detail.verdict.suggestions.map((s, i) => <li key={i} style={{ whiteSpace: "pre-wrap" }}>{s}</li>)}
                      </ol>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {drafting && detail && (
        <AiDraftDialog ns={ns} slug={slug} base={base} semver={detail.semver} aiName={aiName} onClose={() => setDrafting(false)} />
      )}
    </section>
  );
}
