"use client";
// Content-risk presentation shared by the review page and the skill page (SKILLY_SPEC.md §37.8).
// Excerpts are rendered as plain text (React escapes them) and never through Markdown: they are
// skill content, and the scanner has already rewritten hidden characters as visible ⟨U+XXXX⟩.
import { Pill } from "./ui";
import {
  CONTENT_RISK_RULES, CONTENT_RISK_STATUS_HINT, CONTENT_RISK_STATUS_LABEL,
  type ContentRiskStatus,
} from "@skilly/shared/content-risk-status";

export interface ContentRiskFinding {
  scanner: string;
  severity: string;
  rule: string;
  message: string;
  path?: string;
  line?: number;
  excerpt?: string;
  ruleset?: number;
}

const SEV_TONE: Record<string, "ok" | "warn" | "danger" | "muted"> = { critical: "danger", high: "danger", medium: "warn", low: "muted", info: "muted" };
const SEV_ORDER = ["critical", "high", "medium", "low", "info"];
const STATUS_TONE: Record<ContentRiskStatus, "ok" | "warn" | "danger" | "muted"> = { pending: "muted", passed: "ok", noted: "warn", flagged: "danger" };

/** The one-line consumer chip (§37.8): label plus a hover/tap explanation, never findings. */
export function ContentRiskChip({ status }: { status: ContentRiskStatus }) {
  return (
    <span title={CONTENT_RISK_STATUS_HINT[status]} data-testid="content-risk-chip" data-status={status}>
      <Pill tone={STATUS_TONE[status]}>{CONTENT_RISK_STATUS_LABEL[status]}</Pill>
    </span>
  );
}

export function ContentRiskStatusPill({ status }: { status: ContentRiskStatus }) {
  return <Pill tone={STATUS_TONE[status]}>{CONTENT_RISK_STATUS_LABEL[status]}</Pill>;
}

/** Findings grouped by file, then by rule (§37.8). Info markers are not listed. */
export function ContentRiskFindingsList({ findings }: { findings: ContentRiskFinding[] }) {
  const shown = findings.filter((f) => f.severity !== "info");
  if (shown.length === 0) return null;
  const byFile = new Map<string, ContentRiskFinding[]>();
  for (const f of shown) {
    const key = f.path ?? "(bundle)";
    byFile.set(key, [...(byFile.get(key) ?? []), f]);
  }
  const files = [...byFile.entries()].sort(([a], [b]) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)));
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {files.map(([path, list]) => {
        const byRule = new Map<string, ContentRiskFinding[]>();
        for (const f of list) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
        const rules = [...byRule.entries()].sort(
          ([, a], [, b]) => SEV_ORDER.indexOf(a[0]!.severity) - SEV_ORDER.indexOf(b[0]!.severity),
        );
        return (
          <div key={path} style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
            <div className="mono" style={{ fontSize: 12, padding: "8px 12px", background: "var(--surface-2)", borderBottom: "1px solid var(--line)", wordBreak: "break-all" }}>{path}</div>
            {rules.map(([rule, items]) => {
              const info = (CONTENT_RISK_RULES as Record<string, { label: string; help: string }>)[rule];
              return (
                <div key={rule} style={{ padding: "10px 12px", borderTop: "1px solid var(--line)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600, fontSize: 13.5 }}>{info?.label ?? rule}</span>
                    <span className="mono muted" style={{ fontSize: 11 }}>{rule}</span>
                  </div>
                  {info && <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 8px" }}>{info.help}</p>}
                  <div style={{ display: "grid", gap: 6 }}>
                    {items.map((f, i) => (
                      <div key={i} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px", alignItems: "baseline" }}>
                        <span><Pill tone={SEV_TONE[f.severity] ?? "muted"}>{f.severity}</Pill></span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13 }}>
                            {f.line ? <span className="mono muted" style={{ fontSize: 11.5, marginRight: 6 }}>line {f.line}</span> : null}
                            {f.message}
                          </div>
                          {f.excerpt && (
                            <code
                              data-testid="content-risk-excerpt"
                              style={{ display: "block", marginTop: 4, padding: "6px 8px", borderRadius: 6, background: "var(--surface-2)", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                            >
                              {f.excerpt}
                            </code>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
