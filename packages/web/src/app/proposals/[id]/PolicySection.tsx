"use client";
// The proposal page's "Policy" section (SKILLY_SPEC.md §47.9): the policy part of the latest
// revision's §46 pre-review run — a status line, then one row per rule (violations first) with the
// cited evidence and the exact rule text judged. Proposers see enforced rules; reviewers also see
// shadow rules and get "Re-check" (the §46 re-run). While the run is pending the page re-polls.
import { useEffect, useState } from "react";
import { Pill } from "../../../components/ui";
import { PolicyResultsList, type PolicyResultView } from "../../../components/Policy";
import { useDateFmt } from "../../../components/DateFormat";
import { POLICY_TRIP_LABEL, type PolicyScope, type PolicyTripReason } from "@skilly/shared/policy";

export interface PolicyTripView {
  ruleId: string;
  title: string;
  scope: PolicyScope;
  reason: PolicyTripReason;
  canOverride: boolean;
}

export interface ProposalPolicyBlock {
  status: "none" | "pending" | "off" | "unavailable" | "skipped" | "failed" | "done";
  partial: boolean;
  model: string | null;
  checkedAt: string | null;
  rulesChecked: number;
  results: PolicyResultView[];
  trips: PolicyTripView[];
  canRecheck: boolean;
}

export function PolicySection({ proposalId, policy, aiName, onReload }: { proposalId: string; policy: ProposalPolicyBlock; aiName: string; onReload: () => void }) {
  const fmt = useDateFmt();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const waiting = policy.status === "pending";

  // Re-poll while the worker hasn't judged the revision yet (the sweep runs every ~30 s).
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(onReload, 15_000);
    return () => clearInterval(t);
  }, [waiting, onReload]);

  const recheck = async () => {
    setBusy(true);
    setMsg(null);
    try {
      // Re-check = the §46 re-run of the current revision (reviewers; rate-limited, audited).
      const r = await fetch(`/api/proposals/${proposalId}/ai-prereview/rerun`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Re-check failed (${r.status})`);
      setMsg("A fresh policy check was queued.");
      onReload();
    } catch (e) {
      setMsg(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const violations = policy.results.filter((r) => r.outcome === "violates" && r.state === "enforced").length;
  const pill =
    policy.status === "pending" ? <Pill tone="muted">check pending</Pill>
    : policy.status === "off" || policy.status === "unavailable" ? <Pill tone="warn">check unavailable</Pill>
    : policy.status === "skipped" ? <Pill tone="warn">check skipped</Pill>
    : policy.status === "failed" ? <Pill tone="danger">check failed</Pill>
    : violations > 0 ? <Pill tone="danger">{violations} violation{violations === 1 ? "" : "s"}</Pill>
    : <Pill tone="ok">no violations</Pill>;

  return (
    <div className="card card-pad" style={{ marginTop: 26 }} id="policy" data-testid="policy-section" data-status={policy.status}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 19 }}>Policy</h2>
        {pill}
        {policy.canRecheck && (
          <button type="button" className="btn btn-ghost" style={{ marginLeft: "auto", fontSize: 12.5 }} disabled={busy} onClick={recheck} data-testid="policy-recheck">
            {busy ? "…" : "Re-check"}
          </button>
        )}
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0, marginBottom: 12 }} data-testid="policy-status-line">
        {policy.status === "pending"
          ? "Policy check pending — the pre-review hasn’t judged this revision yet."
          : policy.status === "off"
            ? `Policy check unavailable — the ${aiName} pre-review is off; accepting will need an override.`
            : policy.status === "unavailable"
              ? `Policy check unavailable — the ${aiName} pre-review can’t run right now; accepting will need an override.`
              : policy.status === "skipped"
                ? "Policy check skipped — too many revisions today; accepting will need an override. A reviewer can re-check."
                : policy.status === "failed"
                  ? "Policy check failed. Accepting will need an override; a reviewer can re-check."
                  : `Checked against ${policy.rulesChecked} rule${policy.rulesChecked === 1 ? "" : "s"}${policy.model ? ` · ${policy.model}` : ""}${policy.checkedAt ? ` · ${fmt.dateTime(policy.checkedAt)}` : ""}.`}
        {policy.partial && policy.status === "done" && ` Not every file was sent to ${aiName} — see the coverage in the pre-review section.`}
        {policy.status === "done" && " AI review can be influenced by the content it reads; a reviewer still decides."}
      </p>
      {msg && <p style={{ fontSize: 13, marginTop: 0 }}>{msg}</p>}
      {policy.status === "done" && <PolicyResultsList results={policy.results} showShadow={policy.canRecheck} />}
    </div>
  );
}

/** The accept-area list of what the override covers (§47.7), with each rule's authority. */
export function PolicyOverrideList({ trips }: { trips: PolicyTripView[] }) {
  const forbidden = trips.filter((t) => !t.canOverride);
  return (
    <div style={{ marginTop: 8, fontSize: 13 }} data-testid="policy-override-list">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Policy</div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {trips.map((t) => (
          <li key={t.ruleId}>
            {t.title} <span className="muted">({t.scope === "platform" ? "platform rule" : "namespace rule"}) — {POLICY_TRIP_LABEL[t.reason]}</span>
          </li>
        ))}
      </ul>
      {forbidden.length > 0 && (
        <p style={{ color: "var(--danger)", margin: "6px 0 0" }} data-testid="policy-override-forbidden">
          Only a platform admin can override {forbidden.map((t) => `“${t.title}”`).join(", ")}.
        </p>
      )}
    </div>
  );
}
