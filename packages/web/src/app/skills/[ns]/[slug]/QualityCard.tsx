"use client";
import { useState } from "react";
import {
  QUALITY_DIMENSIONS, QUALITY_DIMENSION_LABELS, formatStars, qualityModeLine,
  type QualityAiStatus, type QualityMode, type QualityVerdict,
} from "@skilly/shared/quality";
import { QualityStars } from "../../../../components/QualityBadge";
import { QualityFindingsList, type QualityFindingItem } from "../../../../components/QualityFindingsList";

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
}

/**
 * The skill page's Quality card (§41.7): stars + score, the mode line, the findings grouped by
 * level, and — when present — the AI assessment (five dimensions, summary, suggestions). Everyone
 * who can see the skill sees all of it. The Re-assess button is for §4 override holders.
 */
export function QualityCard({ detail, base, onChanged }: { detail: QualityDetailView | null; base: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showFindings, setShowFindings] = useState(true);

  const reassess = async () => {
    if (!detail) return;
    const provider = "the configured AI provider";
    if (!confirm(`This re-runs the rules and, if AI is on, sends the SKILL.md to ${provider} again.`)) return;
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

  return (
    <div className="card card-pad" style={{ marginTop: 20, scrollMarginTop: 80 }} id="quality" data-testid="quality-card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>Quality</h2>
        {detail && <span className="muted mono" style={{ fontSize: 11 }}>v{detail.semver} · ruleset {detail.ruleset}</span>}
        {detail?.canReassess && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} disabled={busy} onClick={reassess} data-testid="quality-reassess">
            {busy ? "re-assessing…" : "re-assess"}
          </button>
        )}
      </div>
      {!detail ? (
        <p className="muted" style={{ fontSize: 14, margin: 0 }} data-testid="quality-pending">Quality check pending — the system scores each published version shortly after it lands.</p>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 13.5, marginBottom: 14 }} data-testid="quality-mode">{qualityModeLine(detail.mode, detail.aiStatus, detail.aiModel)}</p>
          <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 44, lineHeight: 1 }} data-testid="quality-stars-value">{formatStars(detail.stars)}</div>
            <div>
              <QualityStars stars={detail.stars} size={22} />
              <div className="muted mono" style={{ fontSize: 11.5, marginTop: 4 }} data-testid="quality-score">
                {detail.finalScore} / 100
                {detail.mode === "rules+ai" && detail.aiScore !== null ? ` · rules ${detail.rulesScore} · AI ${detail.aiScore}` : ""}
              </div>
            </div>
          </div>
          {err && <div style={{ color: "var(--danger)", fontSize: 13, marginBottom: 10 }}>{err}</div>}

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
              <div className="nav-label" style={{ padding: "0 0 8px" }}>AI assessment</div>
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
  );
}
