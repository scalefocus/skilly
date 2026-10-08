"use client";
// The shared policy-rule editor (SKILLY_SPEC.md §47.3): one component for a namespace's "Policy
// rules" section on the Namespace administration page and the Administration page's "Platform
// policy rules" card. A list of the scope's rules — title, the Shadow / Enforced / Disabled
// switch-group, revision count, last edit, catalog violations — with Edit / History / Delete, plus
// an Add rule form. Plain text everywhere. Also exports the flagged-versions list both pages use.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Pill } from "./ui";
import { useDateFmt } from "./DateFormat";
import {
  POLICY_BODY_MAX,
  POLICY_CONTEXT_MAX,
  POLICY_RULE_STATES,
  POLICY_STATE_LABEL,
  POLICY_TITLE_MAX,
  validatePolicyRuleText,
  type PolicyRuleState,
  type PolicyScope,
} from "@skilly/shared/policy";

interface AdminRule {
  id: string;
  scope: PolicyScope;
  namespaceSlug: string | null;
  title: string;
  body: string;
  context: string | null;
  state: PolicyRuleState;
  revisionNo: number;
  updatedAt: string;
  updatedBy: string | null;
  violations: number;
  cited: boolean;
}

interface Listing {
  platform: AdminRule[];
  namespace: AdminRule[] | null;
  canManagePlatform: boolean;
  canManageNamespace: boolean;
  /** The §46 pre-review is effective (switch on + AI operational). */
  prereviewEffective: boolean;
}

const fieldStyle = { width: "100%", padding: 10, borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-body)", fontSize: 13.5 } as const;
const STATE_TONE: Record<PolicyRuleState, "ok" | "warn" | "muted"> = { enforced: "ok", shadow: "warn", disabled: "muted" };

function RuleForm({ initial, submitLabel, busy, onSubmit, onCancel, withState }: {
  initial: { title: string; body: string; context: string | null; state?: PolicyRuleState };
  submitLabel: string;
  busy: boolean;
  onSubmit: (v: { title: string; body: string; context: string | null; state: PolicyRuleState }) => void;
  onCancel?: () => void;
  withState: boolean;
}) {
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [context, setContext] = useState(initial.context ?? "");
  const [state, setState] = useState<PolicyRuleState>(initial.state ?? "shadow");
  const v = validatePolicyRuleText({ title, body, context });
  return (
    <div style={{ display: "grid", gap: 8 }} data-testid="policy-rule-form">
      <input className="input" aria-label="Title" placeholder="Title — what findings cite (e.g. No external APIs without an approved adapter)" value={title} maxLength={POLICY_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} style={fieldStyle} />
      <textarea aria-label="Rule" placeholder="The rule, in plain language…" value={body} maxLength={POLICY_BODY_MAX} rows={3} onChange={(e) => setBody(e.target.value)} style={{ ...fieldStyle, resize: "vertical" }} />
      <textarea aria-label="Context for the pre-reviewer" placeholder="Context for the pre-reviewer (optional) — allowlists, definitions, compliant and non-compliant examples…" value={context} maxLength={POLICY_CONTEXT_MAX} rows={3} onChange={(e) => setContext(e.target.value)} style={{ ...fieldStyle, resize: "vertical" }} />
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {withState && (
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            Starts as
            <select className="input" value={state} onChange={(e) => setState(e.target.value as PolicyRuleState)} aria-label="Initial state" style={{ padding: "4px 8px" }}>
              {POLICY_RULE_STATES.map((s) => <option key={s} value={s}>{POLICY_STATE_LABEL[s]}</option>)}
            </select>
          </label>
        )}
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !v.ok} onClick={() => v.ok && onSubmit({ ...v.value, state })}>{submitLabel}</button>
        {onCancel && <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>}
        {!v.ok && (title || body) && <span className="muted" style={{ fontSize: 12 }}>{v.error}</span>}
      </div>
    </div>
  );
}

function RuleRow({ rule, busy, onState, onEdit, onDelete }: {
  rule: AdminRule;
  busy: boolean;
  onState: (s: PolicyRuleState) => void;
  onEdit: (v: { title: string; body: string; context: string | null }) => void;
  onDelete: () => void;
}) {
  const fmt = useDateFmt();
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState<{ revisionNo: number; title: string; body: string; context: string | null; author: string | null; createdAt: string }[] | null>(null);
  const toggleHistory = async () => {
    if (history) { setHistory(null); return; }
    const r = await fetch(`/api/policy/rules/${rule.id}/revisions`);
    if (r.ok) setHistory(((await r.json()) as { revisions: NonNullable<typeof history> }).revisions);
  };
  return (
    <div style={{ padding: "10px 12px", borderTop: "1px solid var(--line)" }} data-testid="policy-rule-row" data-rule={rule.title} data-state={rule.state}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>{rule.title}</span>
        <Pill tone={STATE_TONE[rule.state]}>{POLICY_STATE_LABEL[rule.state]}</Pill>
        {rule.violations > 0 && <Pill tone="danger">{rule.violations} published version{rule.violations === 1 ? "" : "s"} violate it</Pill>}
        <span style={{ flex: 1 }} />
        <span role="group" aria-label={`State of ${rule.title}`} style={{ display: "inline-flex", gap: 2 }}>
          {POLICY_RULE_STATES.map((s) => (
            <button
              key={s}
              type="button"
              className={`btn btn-sm${rule.state === s ? " btn-primary" : ""}`}
              aria-pressed={rule.state === s}
              disabled={busy || rule.state === s}
              onClick={() => onState(s)}
              data-testid={`policy-state-${s}`}
            >
              {POLICY_STATE_LABEL[s]}
            </button>
          ))}
        </span>
      </div>
      {!editing && (
        <div style={{ fontSize: 12.5, marginTop: 4 }}>
          <div style={{ whiteSpace: "pre-wrap" }}>{rule.body}</div>
          {rule.context && <div className="muted" style={{ whiteSpace: "pre-wrap", marginTop: 2 }}><strong style={{ fontWeight: 600 }}>Context: </strong>{rule.context}</div>}
        </div>
      )}
      {editing && (
        <div style={{ marginTop: 8 }}>
          <RuleForm initial={rule} submitLabel="Save as a new revision" busy={busy} withState={false} onCancel={() => setEditing(false)} onSubmit={(v) => { onEdit(v); setEditing(false); }} />
        </div>
      )}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 6, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <span>revision {rule.revisionNo}{rule.updatedBy ? ` · ${rule.updatedBy}` : ""} · {fmt.dateTime(rule.updatedAt)}</span>
        {!editing && <button type="button" className="btn btn-ghost" style={{ fontSize: 11.5, padding: "1px 6px" }} onClick={() => setEditing(true)} data-testid="policy-rule-edit">Edit</button>}
        <button type="button" className="btn btn-ghost" style={{ fontSize: 11.5, padding: "1px 6px" }} onClick={() => void toggleHistory()}>{history ? "Hide history" : "History"}</button>
        {/* §47.3: a rule a check has cited can only be disabled — its wording is part of the record. */}
        {!rule.cited && <button type="button" className="btn btn-ghost" style={{ fontSize: 11.5, padding: "1px 6px" }} disabled={busy} onClick={onDelete}>Delete</button>}
      </div>
      {history && (
        <ol style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
          {history.map((h) => (
            <li key={h.revisionNo} style={{ marginBottom: 4 }}>
              <span className="mono">r{h.revisionNo}</span> · {h.author ?? "a former user"} · {fmt.dateTime(h.createdAt)} — <strong style={{ fontWeight: 600 }}>{h.title}</strong>
              <div className="muted" style={{ whiteSpace: "pre-wrap" }}>{h.body}</div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The editor for one scope: `nsSlug` for a namespace's rules, null for the platform's. */
export function PolicyRulesEditor({ nsSlug }: { nsSlug: string | null }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const load = useCallback(async () => {
    const r = await fetch(`/api/policy/rules?all=1${nsSlug ? `&ns=${encodeURIComponent(nsSlug)}` : ""}`);
    if (r.ok) setListing((await r.json()) as Listing);
  }, [nsSlug]);
  useEffect(() => { void load(); }, [load]);

  const call = async (url: string, method: string, body: unknown, ok: string) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string }).error ?? `Request failed (${r.status})`);
      setMsg({ kind: "ok", text: ok });
      await load();
      return true;
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!listing) return <div className="skeleton" style={{ height: 40, borderRadius: "var(--radius-sm)" }} />;
  const rules = (nsSlug ? listing.namespace : listing.platform) ?? [];
  const canManage = nsSlug ? listing.canManageNamespace : listing.canManagePlatform;
  const anyEnforced = rules.some((r) => r.state === "enforced");
  return (
    <div data-testid="policy-rules-editor" data-scope={nsSlug ? "namespace" : "platform"}>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        {nsSlug
          ? `Everyone who can propose to @${nsSlug} can read enforced rules, including their context.`
          : "Every signed-in user can read enforced platform rules, including their context."}{" "}
        New rules start in Shadow: they are judged and shown to admins, but never gate anything.
      </p>
      {!listing.prereviewEffective && anyEnforced && (
        <p style={{ fontSize: 12.5, color: "var(--danger)" }} data-testid="policy-ai-off-notice">
          The AI pre-review is off (or the AI integration is unavailable), so no policy verdicts can be produced. While it is, accepting a proposal here needs an override, and members’ direct publishes go to review.
          {!nsSlug && " Only platform admins can override platform rules, so every accept in every namespace will need a platform admin."}
        </p>
      )}
      {msg && <div style={{ fontSize: 13, marginBottom: 8, color: msg.kind === "err" ? "var(--danger)" : "var(--ok)" }}>{msg.text}</div>}
      {rules.length > 0 ? (
        <div style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
          {rules.map((r) => (
            <RuleRow
              key={r.id}
              rule={r}
              busy={busy || !canManage}
              onState={(s) => void call(`/api/policy/rules/${r.id}/state`, "PUT", { state: s }, `“${r.title}” is now ${POLICY_STATE_LABEL[s]}.`)}
              onEdit={(v) => void call(`/api/policy/rules/${r.id}`, "PATCH", v, "Saved as a new revision.")}
              onDelete={() => {
                if (window.confirm(`Delete “${r.title}”? This can’t be undone.`)) void call(`/api/policy/rules/${r.id}`, "DELETE", undefined, "Rule deleted.");
              }}
            />
          ))}
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 13 }}>No rules yet.</p>
      )}
      {canManage && (
        <div style={{ marginTop: 10 }}>
          {adding ? (
            <RuleForm
              initial={{ title: "", body: "", context: null, state: "shadow" }}
              submitLabel="Add rule"
              busy={busy}
              withState
              onCancel={() => setAdding(false)}
              onSubmit={async (v) => {
                const ok = await call("/api/policy/rules", "POST", { scope: nsSlug ? "namespace" : "platform", namespaceSlug: nsSlug ?? undefined, ...v }, "Rule added.");
                if (ok) setAdding(false);
              }}
            />
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => setAdding(true)} data-testid="policy-add-rule">Add rule</button>
          )}
        </div>
      )}
    </div>
  );
}

interface FlagRow {
  namespaceSlug: string;
  skillSlug: string;
  title: string;
  semver: string;
  status: "flagged" | "noted";
  rules: { ruleId: string; title: string; scope: PolicyScope; dismissed: boolean }[];
  checkedAt: string | null;
}

/** Flagged / noted published versions, or the Shadow preview (§47.9). `endpoint` returns { rows }. */
export function PolicyFlagsList({ endpoint }: { endpoint: string }) {
  const fmt = useDateFmt();
  const [tab, setTab] = useState<"flagged" | "noted" | "shadow">("flagged");
  const [rows, setRows] = useState<FlagRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    const q = tab === "shadow" ? "shadow=1" : `status=${tab}`;
    fetch(`${endpoint}${endpoint.includes("?") ? "&" : "?"}${q}`)
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((j) => !cancelled && setRows(j.rows ?? []))
      .catch(() => !cancelled && setRows([]));
    return () => { cancelled = true; };
  }, [endpoint, tab]);
  return (
    <div data-testid="policy-flags">
      <div role="tablist" style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        {(["flagged", "noted", "shadow"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" className={`btn btn-sm${tab === t ? " btn-primary" : ""}`} onClick={() => setTab(t)}>
            {t === "flagged" ? "Flagged" : t === "noted" ? "Noted" : "Shadow preview"}
          </button>
        ))}
      </div>
      {!rows ? (
        <div className="skeleton" style={{ height: 30, borderRadius: "var(--radius-sm)" }} />
      ) : rows.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>{tab === "shadow" ? "No shadow rule would flag a published version." : `No ${tab} versions.`}</p>
      ) : (
        <div className="rows">
          {rows.map((r) => (
            <div className="row" key={`${r.namespaceSlug}/${r.skillSlug}@${r.semver}`} data-testid="policy-flag-row">
              <div className="grow">
                <Link href={`/skills/${r.namespaceSlug}/${r.skillSlug}#policy`} style={{ fontWeight: 600 }}>{r.title}</Link>{" "}
                <span className="mono muted" style={{ fontSize: 11.5 }}>{r.namespaceSlug}/{r.skillSlug} v{r.semver}</span>
                <div className="sub">{r.rules.map((x) => `${x.title}${x.dismissed ? " (dismissed)" : ""}`).join(" · ")}</div>
              </div>
              {r.checkedAt && <span className="muted mono" style={{ fontSize: 11 }}>{fmt.dateTime(r.checkedAt)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
