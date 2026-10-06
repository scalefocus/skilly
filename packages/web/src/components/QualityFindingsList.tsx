"use client";
import { qualityRuleHint, qualityRuleLabel, type QualityLevel } from "@skilly/shared/quality";

export interface QualityFindingItem { rule: string; level: QualityLevel | null; path: string | null; line: number | null; message: string; excerpt?: string | null }

const LEVELS: QualityLevel[] = ["error", "warn", "info"];
const LEVEL_TONE: Record<QualityLevel, string> = { error: "var(--danger)", warn: "var(--warn, #b7791f)", info: "var(--muted)" };
const LEVEL_LABEL: Record<QualityLevel, string> = { error: "Errors", warn: "Warnings", info: "Notes" };

/**
 * Quality findings grouped error / warn / info (§41.7): rule id, path:line, the specific message
 * and the guide's hint. Excerpts and messages are skill content — rendered as escaped text only.
 */
export function QualityFindingsList({ findings, compact = false }: { findings: QualityFindingItem[]; compact?: boolean }) {
  const groups = LEVELS.map((level) => ({ level, items: findings.filter((f) => (f.level ?? "info") === level) })).filter((g) => g.items.length > 0);
  if (groups.length === 0) return <p className="muted" style={{ fontSize: 13, margin: 0 }}>No findings — every authoring rule passed.</p>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 10 : 14 }} data-testid="quality-findings">
      {groups.map((g) => (
        <div key={g.level}>
          <div className="mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em", color: LEVEL_TONE[g.level], marginBottom: 6 }}>
            {LEVEL_LABEL[g.level]} · {g.items.length}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: compact ? 4 : 8 }}>
            {g.items.map((f, i) => (
              <div key={`${f.rule}-${f.path ?? ""}-${f.line ?? ""}-${i}`} style={{ fontSize: 13, lineHeight: 1.45 }} data-testid="quality-finding" data-rule={f.rule}>
                <span className="mono" style={{ fontWeight: 600, marginRight: 6 }}>{f.rule}</span>
                <span style={{ fontWeight: 600 }}>{qualityRuleLabel(f.rule)}</span>
                {f.path && (
                  <span className="muted mono" style={{ fontSize: 11.5, marginLeft: 6 }}>
                    {f.path}{f.line ? `:${f.line}` : ""}
                  </span>
                )}
                <div className="muted" style={{ fontSize: 12.5 }}>{f.message}</div>
                {!compact && qualityRuleHint(f.rule) && <div style={{ fontSize: 12.5 }}>{qualityRuleHint(f.rule)}</div>}
                {f.excerpt && <div className="mono" style={{ fontSize: 11.5, whiteSpace: "pre-wrap", opacity: 0.8 }} data-testid="quality-excerpt">{f.excerpt}</div>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
