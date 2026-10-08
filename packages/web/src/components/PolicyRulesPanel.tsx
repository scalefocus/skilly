"use client";
// The enforced policy rules that apply to a namespace (SKILLY_SPEC.md §47.1 #5, §47.9): the
// platform's rules plus the namespace's own. Readable by every signed-in user, so authors can
// comply before they submit. Two presentations: a collapsible panel (the propose form) and a link
// that opens a read-only dialog (the catalog's namespace view). Both hide themselves when no rule
// applies.
import { useEffect, useState } from "react";
import { PolicyRuleTextList, type PolicyRuleText } from "./Policy";

export function useEnforcedPolicyRules(ns: string | null): PolicyRuleText[] | null {
  const [rules, setRules] = useState<PolicyRuleText[] | null>(null);
  useEffect(() => {
    const slug = ns?.trim().toLowerCase();
    if (!slug) { setRules(null); return; }
    let cancelled = false;
    fetch(`/api/policy/rules?ns=${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        setRules(j ? [...(j.platform ?? []), ...(j.namespace ?? [])] : null);
      })
      .catch(() => !cancelled && setRules(null));
    return () => { cancelled = true; };
  }, [ns]);
  return rules;
}

/** The propose form's "Policy rules (N)" panel — collapsed by default. */
export function PolicyRulesPanel({ ns }: { ns: string | null }) {
  const rules = useEnforcedPolicyRules(ns);
  if (!rules || rules.length === 0) return null;
  return (
    <details className="card card-pad" style={{ marginTop: 10 }} data-testid="policy-rules-panel">
      <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13.5 }}>Policy rules ({rules.length})</summary>
      <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 10px" }}>
        Submissions to this namespace are checked against these rules before a reviewer looks. A violation needs a reviewer’s override to be accepted.
      </p>
      <PolicyRuleTextList rules={rules} />
    </details>
  );
}

/** The catalog namespace view's "Policy rules (N)" link and its read-only dialog. */
export function PolicyRulesLink({ ns }: { ns: string }) {
  const rules = useEnforcedPolicyRules(ns);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!rules || rules.length === 0) return null;
  return (
    <>
      <button type="button" className="btn btn-ghost" style={{ fontSize: 12.5, padding: "2px 8px" }} onClick={() => setOpen(true)} data-testid="policy-rules-link">
        Policy rules ({rules.length})
      </button>
      {open && (
        <div role="dialog" aria-modal="true" aria-label="Policy rules" className="modal-backdrop" onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "grid", placeItems: "center", zIndex: 60, padding: 16 }}>
          <div className="card card-pad" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640, width: "100%", maxHeight: "80vh", overflow: "auto" }} data-testid="policy-rules-dialog">
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 19, margin: 0 }}>Policy rules for @{ns}</h2>
              <button type="button" className="btn btn-ghost" style={{ marginLeft: "auto" }} onClick={() => setOpen(false)} aria-label="Close">✕</button>
            </div>
            <PolicyRuleTextList rules={rules} />
          </div>
        </div>
      )}
    </>
  );
}
