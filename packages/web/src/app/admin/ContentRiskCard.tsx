"use client";
// Administration → Content risk (SKILLY_SPEC.md §37.8): active versions the content check flagged
// (default) or noted, filterable by namespace and rule. Each flagged row has an Acknowledge action
// (the same audited endpoint as the skill page's card) and a link to the findings themselves.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { EmptyState } from "../../components/ui";
import { useDateFmt } from "../../components/DateFormat";
import { ContentRiskStatusPill } from "../../components/ContentRisk";
import { CollapsibleCard } from "./CollapsibleCard";
import { CONTENT_RISK_RULES, contentRiskRuleLabel, type ContentRiskStatus } from "@skilly/shared/content-risk-status";

interface Row { namespaceSlug: string; skillSlug: string; title: string; semver: string; status: ContentRiskStatus; rules: string[]; detectedAt: string }

const RULE_OPTIONS = Object.keys(CONTENT_RISK_RULES).filter((r) => r !== "cr-scanned" && r !== "cr-truncated");

export function ContentRiskAdminCard({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const fmt = useDateFmt();
  const [status, setStatus] = useState<"flagged" | "noted" | "all">("flagged");
  const [nsInput, setNsInput] = useState("");
  const [ns, setNs] = useState("");
  // Debounce the namespace slug box so the list re-queries once typing pauses.
  useEffect(() => {
    const t = window.setTimeout(() => setNs(nsInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [nsInput]);
  const [rule, setRule] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [acking, setAcking] = useState<string | null>(null);

  const acknowledge = async (r: Row) => {
    const id = `${r.namespaceSlug}/${r.skillSlug}@${r.semver}`;
    if (!window.confirm(`Acknowledge the content-check findings on ${id}? This is audit-logged.`)) return;
    setAcking(id); setErr(null);
    try {
      const res = await fetch(`/api/skills/${r.namespaceSlug}/${r.skillSlug}/content-risk/acknowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ semver: r.semver }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Could not acknowledge");
      await load();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setAcking(null);
    }
  };

  const load = useCallback(async () => {
    setErr(null);
    const q = new URLSearchParams({ status });
    if (ns) q.set("ns", ns);
    if (rule) q.set("rule", rule);
    try {
      const r = await fetch(`/api/admin/content-risk?${q}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Could not load");
      setRows(j.rows as Row[]);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  }, [status, ns, rule]);
  useEffect(() => { if (open) void load(); }, [open, load]);

  const flaggedCount = status === "flagged" && rows ? rows.length : null;
  const select = { padding: "6px 8px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontSize: 13 } as const;
  return (
    <CollapsibleCard cardId="contentrisk" title="Content risk" summary={flaggedCount != null ? `${flaggedCount} flagged` : undefined} open={open} onToggle={onToggle}>
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 14 }}>
        Published versions whose text the content check flagged. A flagged version stays installable until someone acts: open it to
        review the findings and acknowledge them, or yank the version.
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} style={select}>
          <option value="flagged">Flagged</option>
          <option value="noted">Noted</option>
          <option value="all">Flagged and noted</option>
        </select>
        <input aria-label="Namespace slug" placeholder="Namespace slug (all)" value={nsInput} onChange={(e) => setNsInput(e.target.value)} style={{ ...select, minWidth: 180 }} />
        <select aria-label="Rule" value={rule} onChange={(e) => setRule(e.target.value)} style={select}>
          <option value="">All rules</option>
          {RULE_OPTIONS.map((r) => <option key={r} value={r}>{contentRiskRuleLabel(r)}</option>)}
        </select>
      </div>
      {err && <div style={{ fontSize: 13, color: "var(--danger)", marginBottom: 10 }}>{err}</div>}
      {!rows ? (
        <div className="skeleton" style={{ height: 80, borderRadius: "var(--radius-sm)" }} />
      ) : rows.length === 0 ? (
        <EmptyState title={status === "flagged" ? "Nothing is flagged" : "No matching versions"} hint="The content check runs on every upload and re-checks the catalog in the background." />
      ) : (
        <div className="rows">
          {rows.map((r) => (
            <div className="row" key={`${r.namespaceSlug}/${r.skillSlug}@${r.semver}`} style={{ flexWrap: "wrap" }}>
              <div className="grow" style={{ minWidth: 200 }}>
                <Link href={`/skills/${r.namespaceSlug}/${r.skillSlug}#content-risk`} style={{ fontWeight: 600 }}>{r.title}</Link>
                <div className="sub mono" style={{ fontSize: 11.5 }}>@{r.namespaceSlug}/{r.skillSlug} · v{r.semver}</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{r.rules.map(contentRiskRuleLabel).join(" · ")}</div>
              </div>
              <ContentRiskStatusPill status={r.status} />
              <span className="muted mono" style={{ fontSize: 11 }}>{fmt.dateTime(r.detectedAt)}</span>
              <Link className="btn btn-sm" href={`/skills/${r.namespaceSlug}/${r.skillSlug}#content-risk`}>Review →</Link>
              {r.status === "flagged" && (
                <button type="button" className="btn btn-sm" disabled={acking !== null} onClick={() => void acknowledge(r)}>
                  {acking === `${r.namespaceSlug}/${r.skillSlug}@${r.semver}` ? "Acknowledging…" : "Acknowledge"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </CollapsibleCard>
  );
}

/** Maintenance line (§37.8): how far the background re-check has got at the current ruleset. */
export function ContentCheckLine() {
  const [p, setP] = useState<{ total: number; checked: number; ruleset: number } | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/jobs/content-risk");
      if (r.ok) setP(await r.json());
    } catch { /* transient — the poll retries */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const outstanding = !!p && p.checked < p.total;
  useEffect(() => {
    if (!outstanding) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [outstanding, load]);
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>Content check</div>
      <div className="muted mono" style={{ fontSize: 11.5 }} data-testid="content-check-progress">
        {p ? `${p.checked} of ${p.total} active versions checked at ruleset ${p.ruleset}` : "…"}
      </div>
    </div>
  );
}
