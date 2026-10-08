"use client";
// The skill page's owner-only "Policy" card (SKILLY_SPEC.md §47.9). Shown to effective
// maintainers, namespace admins of the skill's namespace and platform admins. Collapsible like the
// Content risk card; a `#policy` fragment (the skill.policy_flag notification's link) opens it.
// Starts expanded when the version is flagged. Shadow rules are listed for the admins only.
import { useCallback, useEffect, useRef, useState } from "react";
import { Pill } from "../../../../components/ui";
import { useDateFmt } from "../../../../components/DateFormat";
import { PolicyResultsList, type PolicyResultView } from "../../../../components/Policy";
import {
  POLICY_DISMISS_REASON_MAX,
  POLICY_DISMISSAL_LABEL,
  POLICY_STATUS_LABEL,
  type PolicyDismissalKind,
  type PolicyVersionStatus,
} from "@skilly/shared/policy";

interface Detail {
  semver: string;
  status: PolicyVersionStatus;
  verdict: { status: "pending" | "done" | "failed"; model: string | null; checkedAt: string | null; partial: boolean; attempts: number } | null;
  prereviewEffective: boolean;
  results: PolicyResultView[];
  otherFlagged: string[];
  canRecheck: boolean;
}

const STATUS_TONE: Record<PolicyVersionStatus, "ok" | "warn" | "danger" | "muted"> = { none: "muted", pending: "muted", clear: "ok", noted: "warn", flagged: "danger" };

export function PolicyCard({ ns, slug, initialStatus, onChanged }: { ns: string; slug: string; initialStatus: PolicyVersionStatus | null; onChanged: () => void }) {
  const fmt = useDateFmt();
  const [semver, setSemver] = useState<string | null>(null);
  const [data, setData] = useState<Detail | null>(null);
  const [open, setOpen] = useState(initialStatus === "flagged");
  const [settled, setSettled] = useState(false);
  const [dismissing, setDismissing] = useState<PolicyResultView | null>(null);
  const [kind, setKind] = useState<PolicyDismissalKind>("false_positive");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const cardRef = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/skills/${ns}/${slug}/policy${semver ? `?semver=${encodeURIComponent(semver)}` : ""}`);
    if (r.ok) setData((await r.json()) as Detail);
  }, [ns, slug, semver]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (window.location.hash === "#policy") {
      setOpen(true);
      window.setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  }, []);
  useEffect(() => {
    if (!open) { setSettled(false); return; }
    const t = window.setTimeout(() => setSettled(true), 220);
    return () => window.clearTimeout(t);
  }, [open]);

  const post = async (url: string, body: unknown, ok: string) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
      setMsg({ kind: "ok", text: ok });
      setDismissing(null); setReason("");
      await load();
      onChanged();
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  const bodyId = "skill-policy-body";
  const v = data?.verdict;
  return (
    <section ref={cardRef} id="policy" className="card reveal" style={{ marginTop: 20, scrollMarginTop: 80 }} data-testid="policy-card">
      <button type="button" className="admin-card-head" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={bodyId}>
        <h2 className="admin-card-title" style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>Policy</h2>
        {data && data.status !== "none" && <span className="admin-card-summary"><Pill tone={STATUS_TONE[data.status]}>{POLICY_STATUS_LABEL[data.status]}</Pill></span>}
        <span style={{ flex: 1 }} />
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="admin-card-chevron" data-open={open}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div className="admin-card-body" data-open={open} data-settled={settled} id={bodyId} role="region" aria-hidden={!open}>
        <div className="admin-card-body-inner">
          <div className="admin-card-body-pad">
            {!data ? (
              <div className="skeleton" style={{ height: 60, borderRadius: "var(--radius-sm)" }} />
            ) : (
              <>
                <p className="muted" style={{ fontSize: 13.5, marginTop: 0, marginBottom: 14 }}>
                  How <span className="mono">v{data.semver}</span> measures up against the namespace’s and the platform’s policy rules.
                  Only maintainers and admins see this; everyone else sees the status line.
                  {v?.status === "done" && v.checkedAt ? ` Checked ${fmt.dateTime(v.checkedAt)}${v.model ? ` by ${v.model}` : ""}.` : ""}
                  {v?.status === "done" && v.partial ? " Not every file was sent to the pre-review — see its coverage." : ""}
                </p>
                {!v || v.status === "pending" ? (
                  <p className="muted" style={{ fontSize: 13 }} data-testid="policy-card-pending">
                    {data.prereviewEffective ? "The policy check is queued; it runs with the AI pre-review in the background." : "Policy check unavailable — the AI pre-review is off or can’t run right now."}
                  </p>
                ) : v.status === "failed" ? (
                  <p style={{ fontSize: 13, color: "var(--danger)" }}>Policy check failed after {v.attempts} attempts.</p>
                ) : data.results.length === 0 ? (
                  <p className="muted" style={{ fontSize: 13 }}>No rule results to show.</p>
                ) : (
                  <PolicyResultsList results={data.results} showShadow={data.canRecheck} onDismiss={(r) => { setDismissing(r); setMsg(null); }} />
                )}

                {dismissing && (
                  <div style={{ marginTop: 14, padding: 12, border: "1px solid var(--line)", borderRadius: "var(--radius-sm)" }} data-testid="policy-dismiss-form">
                    <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 8 }}>Dismiss “{dismissing.title}” for v{data.semver}</div>
                    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13 }}>
                      {(["false_positive", "accepted_exception"] as const).map((k) => (
                        <label key={k} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <input type="radio" name="policy-dismiss-kind" checked={kind === k} onChange={() => setKind(k)} />
                          {POLICY_DISMISSAL_LABEL[k]}
                        </label>
                      ))}
                    </div>
                    <textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value.slice(0, POLICY_DISMISS_REASON_MAX))}
                      placeholder="Reason (required) — why this flag doesn’t need action…"
                      rows={2}
                      aria-label="Dismissal reason"
                      style={{ width: "100%", marginTop: 8, padding: 10, borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-body)", fontSize: 13.5, resize: "vertical" }}
                    />
                    <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={busy || !reason.trim()}
                        onClick={() => void post(`/api/skills/${ns}/${slug}/policy/dismiss`, { semver: data.semver, ruleId: dismissing.ruleId, kind, reason }, "Flag dismissed.")}
                      >
                        Dismiss flag
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => setDismissing(null)}>Cancel</button>
                      <span className="muted" style={{ fontSize: 12 }}>Audit-logged. The version stays installable either way.</span>
                    </div>
                  </div>
                )}

                {data.canRecheck && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ marginTop: 14 }}
                    disabled={busy}
                    data-testid="policy-card-recheck"
                    // Re-check = the §46 owner re-run of this version (override holders).
                    onClick={() => void post(`/api/skills/${ns}/${slug}/ai-prereview/rerun`, { semver: data.semver }, "A fresh check was queued.")}
                  >
                    Re-check policy
                  </button>
                )}
                {msg && <div style={{ marginTop: 10, fontSize: 13, color: msg.kind === "err" ? "var(--danger)" : "var(--ok)" }}>{msg.text}</div>}

                {data.otherFlagged.length > 0 && (
                  <div style={{ marginTop: 16, fontSize: 13 }}>
                    Other active versions flagged:{" "}
                    {data.otherFlagged.map((sv, i) => (
                      <span key={sv}>
                        {i > 0 && ", "}
                        <button type="button" className="btn-ghost mono" style={{ padding: 0, fontSize: 13, textDecoration: "underline" }} onClick={() => setSemver(sv)}>v{sv}</button>
                      </span>
                    ))}
                  </div>
                )}
                {semver && (
                  <button type="button" className="btn btn-sm" style={{ marginTop: 12 }} onClick={() => setSemver(null)}>Back to the latest version</button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
