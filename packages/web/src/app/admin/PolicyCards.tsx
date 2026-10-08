"use client";
// Administration → policy (SKILLY_SPEC.md §47.3, §47.9): the "Platform policy rules" card (the
// shared rule editor at platform scope) and the "Policy" card (flagged / noted versions across all
// namespaces + the Shadow preview). The queue is the §46 pre-review's (its pending count).
import { CollapsibleCard } from "./CollapsibleCard";
import { PolicyFlagsList, PolicyRulesEditor } from "../../components/PolicyRulesEditor";

export function PlatformPolicyRulesCard({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <CollapsibleCard cardId="policyrules" title="Platform policy rules" open={open} onToggle={onToggle}>
      <p className="muted" style={{ fontSize: 13.5, marginTop: 0 }}>
        Plain-language rules every submission in every namespace is checked against. The AI pre-reviewer cites the rule it tripped; only platform admins can override a platform rule.
      </p>
      <PolicyRulesEditor nsSlug={null} />
    </CollapsibleCard>
  );
}

export function PolicyFlagsAdminCard({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <CollapsibleCard cardId="policy" title="Policy" open={open} onToggle={onToggle}>
      <p className="muted" style={{ fontSize: 13.5, marginTop: 0 }}>
        Published versions that violate an enforced policy rule — flagged until an admin dismisses them, noted after — and what each shadow rule would flag.
      </p>
      <PolicyFlagsList endpoint="/api/admin/policy" />
    </CollapsibleCard>
  );
}
