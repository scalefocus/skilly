"use client";
// The AI pre-review presentation (SKILLY_SPEC.md §46.8), shared by the review/proposal page section
// and the skill page's owner card. Model output (summary, rationale, suggestion) is about possibly
// hostile content, so it is rendered as escaped plain text — React text nodes, never Markdown or
// HTML. "No findings" is worded neutrally and never green: the judge can be talked out of a finding.
import { useCallback, useEffect, useState } from "react";
import { Modal, Pill } from "./ui";
import { useDateFmt } from "./DateFormat";
import {
  PREREVIEW_CATEGORIES, PREREVIEW_CATEGORY_INFO, PREREVIEW_CAVEAT, PREREVIEW_REASON_MAX, prereviewSeverityRank,
  type PrereviewCoverageEntry, type PrereviewFindingView, type PrereviewRunView, type PrereviewSeverity, type PrereviewView, type PrereviewVerdict,
} from "@skilly/shared/ai-prereview";

const SEV_TONE: Record<PrereviewSeverity, "danger" | "warn" | "muted"> = { critical: "danger", high: "danger", medium: "warn", low: "muted" };

/** The header pill for a view. */
export function AiPrereviewStatusPill({ view }: { view: PrereviewView }) {
  const run = view.run;
  switch (view.status) {
    case "pending":
      return <Pill tone="muted">pending</Pill>;
    case "failed":
      return <Pill tone="warn">failed</Pill>;
    case "skipped":
      return <Pill tone="muted">skipped</Pill>;
    case "off":
      return <Pill tone="muted">off</Pill>;
    case "unavailable":
      return <Pill tone="muted">unavailable</Pill>;
    case "none":
      return <Pill tone="muted">not reviewed</Pill>;
    case "done":
      return run?.maxSeverity ? <Pill tone={SEV_TONE[run.maxSeverity]}>{run.maxSeverity}</Pill> : <Pill tone="muted">no issues reported</Pill>;
  }
}

function coverageLine(c: PrereviewCoverageEntry[]): string {
  const reviewed = c.filter((x) => x.status === "reviewed" || x.status === "truncated").length;
  const truncated = c.filter((x) => x.status === "truncated").length;
  const notReviewed = c.filter((x) => x.status === "skipped" || x.status === "out_of_scope").length;
  return [`Reviewed ${reviewed} file${reviewed === 1 ? "" : "s"}`, truncated ? `${truncated} truncated` : null, notReviewed ? `${notReviewed} not reviewed` : null]
    .filter(Boolean)
    .join(" · ");
}

const COVERAGE_LABEL: Record<PrereviewCoverageEntry["status"], string> = {
  reviewed: "reviewed",
  truncated: "truncated — only the beginning was reviewed",
  skipped: "not reviewed — over the size limits",
  out_of_scope: "not reviewed — outside SKILL.md, scripts/ and references/",
};

function Finding({
  f,
  canDisposition,
  onDisposition,
}: {
  f: PrereviewFindingView;
  canDisposition: boolean;
  onDisposition: (fingerprint: string, verdict: PrereviewVerdict, reason: string | null) => Promise<void>;
}) {
  const fmt = useDateFmt();
  const [draft, setDraft] = useState<PrereviewVerdict | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await onDisposition(f.fingerprint, draft, reason.trim() || null);
      setDraft(null);
      setReason("");
    } finally {
      setBusy(false);
    }
  };
  const d = f.disposition;
  return (
    <div style={{ padding: "10px 12px", borderTop: "1px solid var(--line)" }} data-testid="ai-prereview-finding" data-fingerprint={f.fingerprint}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Pill tone={SEV_TONE[f.severity]}>{f.severity}</Pill>
        <span className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{f.path}{f.line ? `:${f.line}` : ""}</span>
        {d && (
          <span style={{ marginLeft: "auto" }} data-testid="ai-prereview-disposition">
            <Pill tone={d.verdict === "agree" ? "warn" : "muted"}>{d.verdict === "agree" ? "agreed" : "dismissed"}</Pill>
          </span>
        )}
      </div>
      <code
        data-testid="ai-prereview-excerpt"
        style={{ display: "block", marginTop: 6, padding: "6px 8px", borderRadius: 6, background: "var(--surface-2)", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
      >
        {f.excerpt}
      </code>
      {f.rationale && <p style={{ fontSize: 13, margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{f.rationale}</p>}
      {f.suggestion && (
        <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 0", whiteSpace: "pre-wrap" }}>
          <strong>Suggested fix:</strong> {f.suggestion}
        </p>
      )}
      {d && (
        <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
          {d.verdict === "agree" ? "Agreed" : "Dismissed"} by {d.by ?? "a former user"} · {fmt.dateTime(d.at)}
          {d.reason ? <span style={{ display: "block", whiteSpace: "pre-wrap" }}>{d.reason}</span> : null}
        </p>
      )}
      {canDisposition && !draft && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button type="button" className="btn btn-sm" onClick={() => setDraft("agree")} data-testid="ai-prereview-agree">Agree</button>
          <button type="button" className="btn btn-sm" onClick={() => setDraft("dismiss")} data-testid="ai-prereview-dismiss">Dismiss</button>
        </div>
      )}
      {canDisposition && draft && (
        <div style={{ marginTop: 8 }}>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, PREREVIEW_REASON_MAX))}
            placeholder={draft === "dismiss" ? "Optional — why this is not a problem…" : "Optional note…"}
            rows={2}
            aria-label="Reason"
            data-testid="ai-prereview-reason"
            style={{ width: "100%", padding: 8, borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-body)", fontSize: 13, resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void save()} data-testid="ai-prereview-save">
              {draft === "agree" ? "Agree" : "Dismiss"}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setDraft(null); setReason(""); }}>Cancel</button>
            <span className="muted" style={{ fontSize: 11.5 }}>Recorded and audit-logged. It never blocks or allows anything.</span>
          </div>
        </div>
      )}
    </div>
  );
}

function RunBody({
  run,
  aiName,
  canDisposition,
  onDisposition,
}: {
  run: PrereviewRunView;
  aiName: string;
  canDisposition: boolean;
  onDisposition: (fingerprint: string, verdict: PrereviewVerdict, reason: string | null) => Promise<void>;
}) {
  const fmt = useDateFmt();
  const byCategory = PREREVIEW_CATEGORIES.map((c) => ({
    category: c,
    items: run.findings.filter((f) => f.category === c).sort((a, b) => prereviewSeverityRank(a.severity) - prereviewSeverityRank(b.severity)),
  })).filter((g) => g.items.length > 0);
  const notReviewed = run.coverage.filter((c) => c.status !== "reviewed");
  return (
    <>
      {run.summary && <p style={{ fontSize: 13.5, margin: "0 0 12px", whiteSpace: "pre-wrap" }} data-testid="ai-prereview-summary">{run.summary}</p>}
      {run.findings.length === 0 ? (
        <p className="muted" style={{ fontSize: 13, margin: "0 0 10px" }} data-testid="ai-prereview-no-issues">
          {aiName} reported no issues in the files it reviewed.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {byCategory.map((g) => (
            <div key={g.category} style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
              <div style={{ padding: "8px 12px", background: "var(--surface-2)" }}>
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>{PREREVIEW_CATEGORY_INFO[g.category].label}</span>
                <span className="mono muted" style={{ fontSize: 11, marginLeft: 8 }}>{g.category}</span>
                <p className="muted" style={{ fontSize: 12.5, margin: "2px 0 0" }}>{PREREVIEW_CATEGORY_INFO[g.category].help}</p>
              </div>
              {g.items.map((f) => (
                <Finding key={f.fingerprint} f={f} canDisposition={canDisposition} onDisposition={onDisposition} />
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
        {run.coverage.length > 0 && <span data-testid="ai-prereview-coverage">{coverageLine(run.coverage)}</span>}
        {run.discarded > 0 && <span> · {run.discarded} finding{run.discarded === 1 ? " was" : "s were"} discarded as unverifiable</span>}
        {run.model && <span> · {run.model}</span>}
        {run.completedAt && <span> · {fmt.dateTime(run.completedAt)}</span>}
      </div>
      {notReviewed.length > 0 && (
        <details style={{ marginTop: 6, fontSize: 12 }}>
          <summary className="muted" style={{ cursor: "pointer" }}>Files not fully reviewed ({notReviewed.length})</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {notReviewed.map((c) => (
              <li key={c.path}><span className="mono">{c.path}</span> <span className="muted">— {COVERAGE_LABEL[c.status]}</span></li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * The body of the section / card. `rerunUrl` + `rerunBody` and `dispositionUrl` + `dispositionExtra`
 * point at the proposal or the version endpoints; `onChanged` reloads the owner's data.
 */
export function AiPrereviewBody({
  view,
  aiName,
  providerLabel,
  rerunUrl,
  rerunBody,
  dispositionUrl,
  dispositionExtra,
  onChanged,
}: {
  view: PrereviewView;
  aiName: string;
  providerLabel?: string;
  rerunUrl: string;
  rerunBody?: Record<string, unknown>;
  dispositionUrl: string;
  dispositionExtra?: Record<string, unknown>;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const rerun = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(rerunUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rerunBody ?? {}) });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error === "already_pending" ? "A pre-review is already pending." : j.error === "ai_prereview_unavailable" ? `${aiName} pre-review is not available right now.` : j.error ?? "Could not start the pre-review");
      setConfirming(false);
      onChanged();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const disposition = async (fingerprint: string, verdict: PrereviewVerdict, reason: string | null) => {
    setErr(null);
    const r = await fetch(dispositionUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(dispositionExtra ?? {}), fingerprint, verdict, reason }),
    });
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) {
      setErr(j.error === "unknown_finding" ? "That finding is no longer in the current result — reload the page." : j.error ?? "Could not save");
      return;
    }
    onChanged();
  };

  const run = view.run;
  return (
    <div data-testid="ai-prereview-body" data-status={view.status}>
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 12px", fontStyle: "italic" }} data-testid="ai-prereview-caveat">{PREREVIEW_CAVEAT}</p>

      {view.mismatch && (
        <div
          role="alert"
          data-testid="ai-prereview-mismatch"
          style={{ border: "1px solid var(--warn)", background: "var(--warn-soft)", borderRadius: "var(--radius-sm)", padding: "10px 12px", fontSize: 13, marginBottom: 12 }}
        >
          <strong>The content check found override or concealment wording that {aiName} did not report.</strong> Treat this result with suspicion.
        </div>
      )}

      {view.status === "pending" && <p className="muted" style={{ fontSize: 13, margin: 0 }}>Pending — usually within a few minutes. Nothing waits for it: you can review in the meantime.</p>}
      {view.status === "off" && <p className="muted" style={{ fontSize: 13, margin: 0 }}>{aiName} pre-review is off.</p>}
      {view.status === "unavailable" && <p className="muted" style={{ fontSize: 13, margin: 0 }}>{aiName} pre-review is unavailable — the AI integration is not operational.</p>}
      {view.status === "skipped" && <p className="muted" style={{ fontSize: 13, margin: 0 }}>{aiName} pre-review skipped: too many revisions today. A reviewer can run it.</p>}
      {view.status === "none" && <p className="muted" style={{ fontSize: 13, margin: 0 }}>Not reviewed.</p>}
      {view.status === "failed" && run && (
        <p style={{ fontSize: 13, margin: 0, color: "var(--danger)" }} data-testid="ai-prereview-failed">
          Failed{run.lastError ? ` — ${run.lastError}` : ""}.
        </p>
      )}
      {view.status === "done" && run && (
        <RunBody run={run} aiName={aiName} canDisposition={view.canDisposition} onDisposition={disposition} />
      )}

      {view.previous && (
        <details style={{ marginTop: 14 }}>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Previous result (revision {view.previous.revision})</summary>
          <div style={{ marginTop: 10 }}>
            <RunBody run={view.previous} aiName={aiName} canDisposition={false} onDisposition={disposition} />
          </div>
        </details>
      )}

      {view.canRerun && (
        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn btn-sm" onClick={() => setConfirming(true)} data-testid="ai-prereview-rerun">
            {view.status === "none" ? "Run" : "Re-run"}
          </button>
        </div>
      )}
      {err && <div style={{ marginTop: 10, fontSize: 13, color: "var(--danger)" }}>{err}</div>}

      {confirming && (
        <Modal
          title={`${view.status === "none" ? "Run" : "Re-run"} the ${aiName} pre-review?`}
          onCancel={() => setConfirming(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={() => void rerun()} disabled={busy} data-testid="ai-prereview-rerun-confirm">
                {view.status === "none" ? "Run" : "Re-run"}
              </button>
            </>
          }
        >
          <p style={{ margin: 0, fontSize: 14 }}>This sends the files to {providerLabel ?? "the AI provider"} again. The result appears here when the worker has run it.</p>
        </Modal>
      )}
    </div>
  );
}

/** While a run is pending, re-fetch every 20 s (a section never blanks the page to refresh). */
export const PREREVIEW_POLL_MS = 20_000;

/**
 * Keep a view fresh without reloading its page: `fetchView` re-reads it (after a re-run or a
 * disposition, and on a timer while it is pending).
 */
export function useLivePrereview<T extends PrereviewView>(initial: T | null, fetchView: () => Promise<T | null>): { view: T | null; refresh: () => void } {
  const [view, setView] = useState<T | null>(initial);
  useEffect(() => { setView(initial); }, [initial]);
  const refresh = useCallback(() => {
    void fetchView().then((v) => { if (v) setView(v); }).catch(() => {});
  }, [fetchView]);
  const pending = view?.status === "pending";
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(refresh, PREREVIEW_POLL_MS);
    return () => window.clearInterval(t);
  }, [pending, refresh]);
  return { view, refresh };
}
