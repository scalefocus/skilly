"use client";
// Policy-rule presentation shared by the propose form, the proposal / review page, the skill page,
// the catalog's namespace view and the admin surfaces (SKILLY_SPEC.md §47.9). Rule text, model
// explanations and evidence excerpts are rendered as escaped plain text (React escapes them) —
// never Markdown: the first is admin-authored policy, the rest is model output about possibly
// hostile content, and excerpts already show hidden characters as visible ⟨U+XXXX⟩ markers.
import { useState } from "react";
import { Pill } from "./ui";
import {
  POLICY_OUTCOME_LABEL,
  POLICY_STATUS_HINT,
  POLICY_STATUS_LABEL,
  POLICY_DISMISSAL_LABEL,
  type PolicyDismissalKind,
  type PolicyOutcome,
  type PolicyScope,
  type PolicyVersionStatus,
} from "@skilly/shared/policy";

export interface PolicyEvidenceView {
  path: string;
  line: number | null;
  excerpt: string;
}

/** One rule's result as the Policy sections show it. */
export interface PolicyResultView {
  ruleId: string;
  revisionNo: number;
  scope: PolicyScope;
  namespaceSlug: string | null;
  title: string;
  body: string;
  context: string | null;
  state: "enforced" | "shadow";
  stale: boolean;
  outcome: PolicyOutcome;
  explanation: string;
  evidence: PolicyEvidenceView[];
  evidenceRejected: boolean;
  dismissal?: { kind: PolicyDismissalKind; reason: string; source: "override" | "manual"; by: string | null; at: string } | null;
  canDismiss?: boolean;
}

export interface PolicyRuleText {
  id: string;
  scope: PolicyScope;
  namespaceSlug: string | null;
  title: string;
  body: string;
  context: string | null;
}

const OUTCOME_TONE: Record<PolicyOutcome, "ok" | "warn" | "danger" | "muted"> = { violates: "danger", uncertain: "warn", complies: "ok", not_applicable: "muted" };
const STATUS_TONE: Record<Exclude<PolicyVersionStatus, "none">, "ok" | "warn" | "danger" | "muted"> = { pending: "muted", clear: "ok", noted: "warn", flagged: "danger" };

export function PolicyOutcomePill({ outcome }: { outcome: PolicyOutcome }) {
  return <Pill tone={OUTCOME_TONE[outcome]}>{POLICY_OUTCOME_LABEL[outcome]}</Pill>;
}

export function PolicyScopeChip({ scope, namespaceSlug }: { scope: PolicyScope; namespaceSlug: string | null }) {
  return <Pill tone="muted">{scope === "platform" ? "Platform" : `@${namespaceSlug ?? "namespace"}`}</Pill>;
}

/** The one-line consumer chip (§47.9): label + hover explanation naming the violated rules. */
export function PolicyChip({ status, violatedTitles }: { status: Exclude<PolicyVersionStatus, "none">; violatedTitles: string[] }) {
  const hint = violatedTitles.length ? `${POLICY_STATUS_HINT[status]} Rules: ${violatedTitles.join(", ")}.` : POLICY_STATUS_HINT[status];
  return (
    <span title={hint} data-testid="policy-chip" data-status={status}>
      <Pill tone={STATUS_TONE[status]}>{POLICY_STATUS_LABEL[status]}</Pill>
    </span>
  );
}

function RuleText({ body, context }: { body: string; context: string | null }) {
  return (
    <div style={{ fontSize: 12.5, display: "grid", gap: 4 }}>
      <div style={{ whiteSpace: "pre-wrap" }}>{body}</div>
      {context && (
        <div className="muted" style={{ whiteSpace: "pre-wrap" }}>
          <strong style={{ fontWeight: 600 }}>Context: </strong>
          {context}
        </div>
      )}
    </div>
  );
}

/** One result row: outcome, title + chips, explanation, evidence, the judged rule text, dismissal. */
function ResultRow({ r, showShadow, onDismiss }: { r: PolicyResultView; showShadow: boolean; onDismiss?: (r: PolicyResultView) => void }) {
  const [open, setOpen] = useState(false);
  const highlight = r.outcome === "uncertain";
  return (
    <div
      data-testid="policy-result"
      data-outcome={r.outcome}
      data-rule={r.title}
      style={{ padding: "10px 12px", borderTop: "1px solid var(--line)", background: highlight ? "var(--surface-2)" : undefined }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <PolicyOutcomePill outcome={r.outcome} />
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>{r.title}</span>
        <PolicyScopeChip scope={r.scope} namespaceSlug={r.namespaceSlug} />
        {showShadow && r.state === "shadow" && <Pill tone="accent">Shadow</Pill>}
        {r.stale && <span className="muted" style={{ fontSize: 11.5 }}>rule edited since — re-check queued</span>}
      </div>
      {highlight && !r.evidenceRejected && <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>Check this manually.</p>}
      {r.explanation && <p style={{ fontSize: 13, margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{r.explanation}</p>}
      {r.evidence.length > 0 && (
        <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
          {r.evidence.map((e, i) => (
            <div key={i}>
              <span className="mono muted" style={{ fontSize: 11.5 }}>
                {e.path}
                {e.line ? `:${e.line}` : ""}
              </span>
              <code
                data-testid="policy-excerpt"
                style={{ display: "block", marginTop: 2, padding: "6px 8px", borderRadius: 6, background: "var(--surface-2)", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              >
                {e.excerpt}
              </code>
            </div>
          ))}
        </div>
      )}
      {r.dismissal && (
        <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }} data-testid="policy-dismissal">
          {POLICY_DISMISSAL_LABEL[r.dismissal.kind]}
          {r.dismissal.source === "override" ? " — accepted at review" : ""}
          {r.dismissal.by ? ` by ${r.dismissal.by}` : ""}: {r.dismissal.reason}
        </p>
      )}
      <div style={{ display: "flex", gap: 12, marginTop: 6, alignItems: "center" }}>
        <button type="button" className="btn btn-ghost" style={{ fontSize: 12, padding: "2px 6px" }} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Hide the rule" : `Show the rule (revision ${r.revisionNo})`}
        </button>
        {onDismiss && r.canDismiss && (
          <button type="button" className="btn btn-ghost" style={{ fontSize: 12, padding: "2px 6px" }} data-testid="policy-dismiss" onClick={() => onDismiss(r)}>
            Dismiss…
          </button>
        )}
      </div>
      {open && (
        <div style={{ marginTop: 6, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 6 }}>
          <RuleText body={r.body} context={r.context} />
        </div>
      )}
    </div>
  );
}

/** Results in display order (the server already sorted: violations, uncertain, complies), N/A collapsed. */
export function PolicyResultsList({ results, showShadow, onDismiss }: { results: PolicyResultView[]; showShadow: boolean; onDismiss?: (r: PolicyResultView) => void }) {
  const [showNa, setShowNa] = useState(false);
  const main = results.filter((r) => r.outcome !== "not_applicable");
  const na = results.filter((r) => r.outcome === "not_applicable");
  if (results.length === 0) return null;
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", overflow: "hidden" }} data-testid="policy-results">
      {main.map((r) => (
        <ResultRow key={r.ruleId} r={r} showShadow={showShadow} onDismiss={onDismiss} />
      ))}
      {na.length > 0 && (
        <div style={{ padding: "8px 12px", borderTop: main.length ? "1px solid var(--line)" : undefined }}>
          <button type="button" className="btn btn-ghost" style={{ fontSize: 12, padding: "2px 6px" }} onClick={() => setShowNa((o) => !o)} aria-expanded={showNa}>
            {showNa ? "Hide" : "Show"} {na.length} not-applicable rule{na.length === 1 ? "" : "s"}
          </button>
        </div>
      )}
      {showNa && na.map((r) => <ResultRow key={r.ruleId} r={r} showShadow={showShadow} onDismiss={onDismiss} />)}
    </div>
  );
}

/** A read-only list of rules (propose-form panel, catalog dialog). */
export function PolicyRuleTextList({ rules }: { rules: PolicyRuleText[] }) {
  return (
    <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 10 }} data-testid="policy-rule-list">
      {rules.map((r) => (
        <li key={r.id}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, fontSize: 13.5 }}>{r.title}</span>
            <PolicyScopeChip scope={r.scope} namespaceSlug={r.namespaceSlug} />
          </div>
          <div style={{ marginTop: 2 }}>
            <RuleText body={r.body} context={r.context} />
          </div>
        </li>
      ))}
    </ol>
  );
}
