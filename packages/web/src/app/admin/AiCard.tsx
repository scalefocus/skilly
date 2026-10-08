"use client";
// Administration → AI integration (§40): the platform's one external LLM provider connection.
// Status pill in the header (so a failing integration stays visible while collapsed), the enable
// switch (gated on a passing test of the saved config), the provider / base URL / write-only token
// / model form with Test + Save (Save runs the test and is rejected on failure), Remove, the last
// test, 30-day usage and the data-egress notice. Platform admins only (every API call re-verifies).
//
// Deliberately imports nothing from @skilly/shared/ai — that subpath is server-only (node:crypto).
import { useCallback, useEffect, useState } from "react";
import {
  AI_CALL_TIMEOUT_MAX_MS,
  AI_CALL_TIMEOUT_MIN_MS,
  AI_DRAFT_RUN_CAP_MAX_MS,
  AI_DRAFT_RUN_CAP_MIN_MS,
  type AiTimeoutsView,
} from "@skilly/shared/ai-timeouts";
import { Pill, Switch, formatCount, useApi } from "../../components/ui";
import { useDateFmt } from "../../components/DateFormat";
import { CollapsibleCard } from "./CollapsibleCard";

type Provider = "openwebui" | "anthropic";
type Status = "not_configured" | "off" | "operational" | "failing";

const PROVIDERS: { id: Provider; label: string; urlHint: string }[] = [
  { id: "openwebui", label: "Open WebUI", urlHint: "https://openwebui.example.com" },
  { id: "anthropic", label: "Anthropic API", urlHint: "https://api.anthropic.com (default)" },
];

interface AiState {
  keyConfigured: boolean;
  configured: boolean;
  enabled: boolean;
  provider: Provider | null;
  providerLabel: string | null;
  baseUrl: string | null;
  model: string | null;
  tokenLast4: string | null;
  tokenDecryptable: boolean;
  status: Status;
  statusReason: string | null;
  statusAt: string | null;
  lastTest: { at: string | null; ok: boolean | null; latencyMs: number | null; error: string | null };
  canEnable: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
  usage30d: { calls: number; failed: number; inputTokens: number; outputTokens: number; byFeature: { feature: string; label: string; calls: number; failed: number; inputTokens: number; outputTokens: number }[] };
  features: { key: string; label: string; egress: string; spec: string }[];
  /** §40.14 the end-user name for the AI. */
  displayName: string;
  /** §40.15 per-call timeouts and the draft run cap. */
  timeouts: AiTimeoutsView;
  /** §46.2 the AI pre-review switch and its queue. */
  prereview: { enabled: boolean; effective: boolean; pending: number; failed24h: number };
}

interface TestResult {
  ok: boolean;
  latencyMs: number;
  model: string | null;
  error: string | null;
  errorCode: string | null;
  httpStatus: number | null;
}

function StatusPill({ s }: { s: AiState }) {
  if (s.status === "operational") return <Pill tone="ok">Operational</Pill>;
  if (s.status === "failing") return <Pill tone="danger">Failing</Pill>;
  if (s.status === "off") return <Pill tone="muted">Off</Pill>;
  return <Pill tone="muted">Not configured</Pill>;
}

function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Normalize like the server does, closely enough to decide whether the stored token may be reused. */
function sameUrl(a: string, b: string | null, provider: Provider): boolean {
  const norm = (s: string) => (s.trim() === "" && provider === "anthropic" ? "https://api.anthropic.com" : s.trim().replace(/\/+$/, ""));
  return b !== null && norm(a) === norm(b);
}

export function AiCard({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const fmt = useDateFmt();
  const { data, reload } = useApi<AiState>("/api/admin/ai");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  // Form state, seeded from the saved config whenever it (re)loads.
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  // Re-seed only when the SAVED config changes (first load, save, remove) — not on every status
  // refresh, or a Test (which reloads the pill) would wipe the admin's unsaved form.
  const savedKey = data ? [data.configured, data.provider, data.baseUrl, data.model, data.tokenLast4, data.updatedAt].join("|") : null;
  useEffect(() => {
    if (!data) return;
    setProvider(data.provider ?? "anthropic");
    setBaseUrl(data.provider === "anthropic" && data.baseUrl === "https://api.anthropic.com" ? "" : (data.baseUrl ?? ""));
    setModel(data.model ?? "");
    setToken("");
    setReplacing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the saved config, see above
  }, [savedKey]);

  // The stored token may be reused only for the saved provider + base URL (§40.1 #7).
  const storedUsable = Boolean(data?.configured && data.tokenDecryptable && data.provider === provider && sameUrl(baseUrl, data.baseUrl, provider));
  const tokenRequired = !storedUsable || replacing;
  const haveToken = token.trim() !== "" || !tokenRequired;
  const urlReady = provider === "anthropic" || baseUrl.trim() !== "";
  const disabledAll = busy || !data || !data.keyConfigured;

  const formBody = useCallback(
    () => ({ provider, baseUrl: baseUrl.trim(), model: model.trim(), token: tokenRequired ? token.trim() : "" }),
    [provider, baseUrl, model, token, tokenRequired],
  );

  const loadModels = useCallback(async () => {
    if (!urlReady || !haveToken || !data?.keyConfigured) return;
    setModelsLoading(true);
    setModelsError(null);
    try {
      const r = await fetch("/api/admin/ai/models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(formBody()) });
      const j = (await r.json().catch(() => ({}))) as { models?: string[]; error?: string; detail?: string | null };
      if (!r.ok || !j.models) throw new Error(j.detail ?? j.error ?? `Failed (${r.status})`);
      setModels(j.models);
    } catch (e) {
      setModels(null);
      setModelsError(String((e as Error).message));
    } finally {
      setModelsLoading(false);
    }
  }, [urlReady, haveToken, data?.keyConfigured, formBody]);

  // Load the list once the card is open and provider + URL + token are available.
  useEffect(() => {
    if (!open || !data?.configured || models !== null || modelsError !== null) return;
    if (storedUsable) void loadModels();
  }, [open, data?.configured, storedUsable, models, modelsError, loadModels]);

  const post = async (url: string, method: string, body?: unknown) => {
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { r, j };
  };

  const runTest = async () => {
    setBusy(true);
    setFlash(null);
    setTest(null);
    try {
      const { r, j } = await post("/api/admin/ai/test", "POST", formBody());
      if (!r.ok) throw new Error(String(j.detail ?? j.error ?? `Failed (${r.status})`));
      setTest(j as unknown as TestResult);
      reload();
    } catch (e) {
      setFlash({ tone: "danger", text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setFlash(null);
    setTest(null);
    try {
      const { r, j } = await post("/api/admin/ai", "PUT", formBody());
      if (j.test) setTest(j.test as TestResult);
      if (!r.ok) throw new Error(r.status === 422 && j.error === "ai_test_failed" ? `Not saved — the test failed: ${String(j.detail ?? "")}` : String(j.detail ?? j.error ?? `Failed (${r.status})`));
      setFlash({ tone: "ok", text: j.unchanged ? "No changes to save." : "Saved — the test passed." });
      setModels(null);
      setModelsError(null);
      reload();
    } catch (e) {
      setFlash({ tone: "danger", text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (next: boolean) => {
    setBusy(true);
    setFlash(null);
    try {
      const { r, j } = await post("/api/admin/ai", "PATCH", { enabled: next });
      if (!r.ok) throw new Error(String(j.detail ?? j.error ?? `Failed (${r.status})`));
      reload();
    } catch (e) {
      setFlash({ tone: "danger", text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm("Remove the AI integration? The configuration and the stored token are deleted and AI is switched off. Usage history is kept.")) return;
    setBusy(true);
    setFlash(null);
    try {
      const r = await fetch("/api/admin/ai", { method: "DELETE" });
      if (!r.ok && r.status !== 404) {
        const j = (await r.json().catch(() => ({}))) as { error?: string; detail?: string };
        throw new Error(j.detail ?? j.error ?? `Failed (${r.status})`);
      }
      setTest(null);
      setModels(null);
      setModelsError(null);
      setFlash({ tone: "ok", text: "AI integration removed." });
      reload();
    } catch (e) {
      setFlash({ tone: "danger", text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  const onProvider = (p: Provider) => {
    if (p === provider) return;
    setProvider(p);
    setBaseUrl("");
    setToken("");
    setModel("");
    setModels(null);
    setModelsError(null);
    setTest(null);
  };

  const summary = data ? (data.configured ? `${data.providerLabel} · ${data.model}` : "not configured") : "…";
  const canSubmit = !disabledAll && urlReady && haveToken && model.trim() !== "";

  return (
    <CollapsibleCard cardId="ai" title="AI integration" summary={summary} accessory={data ? <StatusPill s={data} /> : null} open={open} onToggle={onToggle}>
      <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6, margin: "0 0 12px" }}>
        Connects skilly to one external AI provider that skilly features can use. Saving runs a connectivity test first and is
        rejected if it fails, so a bad change never replaces a working configuration.
      </p>

      {data && !data.keyConfigured && (
        <p style={{ fontSize: 13, margin: "0 0 12px", color: "var(--danger, crimson)" }}>
          Set <code>AI_TOKEN_ENC_KEY</code> — a 32-byte base64 key — on web and worker to configure the AI integration.
        </p>
      )}

      {data?.status === "failing" && data.statusReason && (
        <p style={{ fontSize: 13, margin: "0 0 12px", color: "var(--danger, crimson)" }} data-testid="ai-status-reason">
          Failing — {data.statusReason}
          {data.statusAt ? ` (${fmt.dateTime(data.statusAt)})` : ""}
        </p>
      )}

      {flash && (
        <p role="status" style={{ fontSize: 13, margin: "0 0 12px", color: flash.tone === "ok" ? "var(--ok, var(--muted))" : "var(--danger, crimson)" }}>
          {flash.text}
        </p>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <Switch
          label="AI integration enabled"
          checked={Boolean(data?.enabled)}
          disabled={busy || !data || !data.keyConfigured || (!data.enabled && !data.canEnable)}
          title={data && !data.enabled && !data.canEnable ? "Save a configuration that passes the test first" : undefined}
          onChange={(next) => void setEnabled(next)}
        />
        <span style={{ fontSize: 12.5, color: "var(--faint)", lineHeight: 1.5 }}>
          Switching off keeps the configuration; AI features stop until it is switched back on.
        </span>
      </div>

      <div style={{ display: "grid", gap: 14, maxWidth: 560 }}>
        <div className="sort-toggle" role="group" aria-label="AI provider">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`sort-opt${provider === p.id ? " sort-on" : ""}`}
              aria-pressed={provider === p.id}
              disabled={disabledAll}
              onClick={() => onProvider(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <label style={{ fontSize: 13, display: "grid", gap: 4 }}>
          Base URL{provider === "anthropic" ? " (optional)" : ""}
          <input
            className="input"
            value={baseUrl}
            disabled={disabledAll}
            placeholder={PROVIDERS.find((p) => p.id === provider)!.urlHint}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setModels(null);
              setModelsError(null);
            }}
          />
        </label>

        <div style={{ fontSize: 13, display: "grid", gap: 4 }}>
          <label htmlFor="ai-token">API key / bearer token</label>
          {storedUsable && !replacing ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="mono" data-testid="ai-token-set">Set{data?.tokenLast4 ? ` · ends …${data.tokenLast4}` : ""}</span>
              <button type="button" className="btn btn-sm btn-ghost" disabled={disabledAll} onClick={() => setReplacing(true)}>
                Replace
              </button>
            </div>
          ) : (
            <input
              id="ai-token"
              className="input"
              type="password"
              autoComplete="off"
              value={token}
              disabled={disabledAll}
              placeholder={data?.configured && data.provider === provider ? "Enter the token (required for this provider / URL)" : "Paste the token"}
              onChange={(e) => {
                setToken(e.target.value);
                setModels(null);
                setModelsError(null);
              }}
            />
          )}
        </div>

        <div style={{ fontSize: 13, display: "grid", gap: 4 }}>
          <label htmlFor="ai-model">Model</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {models && models.length > 0 ? (
              <div className="select-wrap" style={{ flex: 1 }}>
                <select
                  id="ai-model"
                  style={{ width: "100%", padding: "10px 38px 10px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-mono)", fontSize: 13.5 }}
                  value={model}
                  disabled={disabledAll}
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option value="">Choose a model…</option>
                  {model && !models.includes(model) && <option value={model}>{model}</option>}
                  {models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <svg className="select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </div>
            ) : (
              <input
                id="ai-model"
                className="input mono"
                style={{ flex: 1 }}
                value={model}
                disabled={disabledAll}
                placeholder={provider === "anthropic" ? "e.g. claude-sonnet-5-5" : "the model id on your Open WebUI"}
                onChange={(e) => setModel(e.target.value)}
              />
            )}
            <button type="button" className="btn btn-sm" disabled={disabledAll || !urlReady || !haveToken || modelsLoading} onClick={() => void loadModels()}>
              {modelsLoading ? "Loading…" : models ? "Refresh" : "Load models"}
            </button>
          </div>
          {modelsError && (
            <span style={{ fontSize: 12.5, color: "var(--danger, crimson)" }}>
              Couldn’t load the model list — type the model id instead. ({modelsError})
            </span>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-sm" disabled={!canSubmit} onClick={() => void runTest()}>
            Test
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!canSubmit} onClick={() => void save()}>
            Save
          </button>
          {data?.configured && (
            <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: "auto", color: "var(--danger, crimson)" }} disabled={disabledAll} onClick={() => void remove()}>
              Remove integration
            </button>
          )}
        </div>

        {test && (
          <p role="status" data-testid="ai-test-result" style={{ fontSize: 13, margin: 0, color: test.ok ? "var(--ok, var(--muted))" : "var(--danger, crimson)" }}>
            {test.ok
              ? `Test passed in ${test.latencyMs} ms — ${test.model ?? "model"} answered.`
              : `Test failed${test.httpStatus ? ` (HTTP ${test.httpStatus})` : ""}: ${test.error ?? "unknown error"}`}
          </p>
        )}
      </div>

      {data?.configured && (
        <p style={{ fontSize: 12.5, color: "var(--faint)", margin: "14px 0 0" }}>
          Last test of the saved configuration:{" "}
          {data.lastTest.at ? (
            <>
              {data.lastTest.ok ? "passed" : "failed"} {fmt.dateTime(data.lastTest.at)}
              {data.lastTest.latencyMs != null ? ` · ${data.lastTest.latencyMs} ms` : ""}
              {!data.lastTest.ok && data.lastTest.error ? ` · ${data.lastTest.error}` : ""}
            </>
          ) : "never"}
          {data.updatedAt ? ` · saved ${fmt.dateTime(data.updatedAt)}${data.updatedByName ? ` by ${data.updatedByName}` : ""}` : ""}
        </p>
      )}

      {data && (
        <>
          <h3 style={{ fontSize: 14, margin: "20px 0 8px" }}>Usage — last 30 days</h3>
          {data.usage30d.calls === 0 ? (
            <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>No AI calls yet.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
            <table className="rum-table" data-testid="ai-usage">
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Feature</th>
                  <th style={{ textAlign: "right" }}>Calls</th>
                  <th style={{ textAlign: "right" }}>Failed</th>
                  <th style={{ textAlign: "right" }}>Input tokens</th>
                  <th style={{ textAlign: "right" }}>Output tokens</th>
                </tr>
              </thead>
              <tbody>
                {data.usage30d.byFeature.map((f) => (
                  <tr key={f.feature}>
                    <td>{f.label}</td>
                    <td style={{ textAlign: "right" }}>{formatCount(f.calls)}</td>
                    <td style={{ textAlign: "right" }}>{formatCount(f.failed)}</td>
                    <td style={{ textAlign: "right" }}>{formatCount(f.inputTokens)}</td>
                    <td style={{ textAlign: "right" }}>{formatCount(f.outputTokens)}</td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 600 }}>
                  <td>Total</td>
                  <td style={{ textAlign: "right" }}>{formatCount(data.usage30d.calls)}</td>
                  <td style={{ textAlign: "right" }}>{formatCount(data.usage30d.failed)}</td>
                  <td style={{ textAlign: "right" }}>{formatCount(data.usage30d.inputTokens)}</td>
                  <td style={{ textAlign: "right" }}>{formatCount(data.usage30d.outputTokens)}</td>
                </tr>
              </tbody>
            </table>
            </div>
          )}

          <h3 style={{ fontSize: 14, margin: "20px 0 8px" }}>Data leaving skilly</h3>
          <p style={{ fontSize: 13, color: "var(--muted)", margin: "0 0 6px" }}>
            {data.configured
              ? <>When enabled, the features below send data to <strong>{data.providerLabel}</strong> at <strong>{hostOf(data.baseUrl)}</strong>.</>
              : "Once configured, the features below send data to the chosen provider."}
          </p>
          {data.features.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }} data-testid="ai-no-features">No skilly features use the AI integration yet.</p>
          ) : (
            <ul style={{ fontSize: 13, margin: 0, paddingLeft: 18 }} data-testid="ai-features">
              {data.features.map((f) => (
                <li key={f.key} data-testid="ai-feature" data-feature={f.key}>
                  <strong>{f.label}</strong> — {f.egress} <span className="muted">({f.spec})</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {data && <PrereviewRow state={data.prereview} providerLabel={data.providerLabel} onSaved={reload} />}
      {data && <TimeoutsRow saved={data.timeouts} onSaved={reload} />}
      {data && <DisplayNameRow saved={data.displayName} onSaved={reload} />}
    </CollapsibleCard>
  );
}

/**
 * §46.2 the AI pre-review switch: saved on toggle, independent of the provider form — usable with
 * no provider configured and without AI_TOKEN_ENC_KEY, kept on Remove integration. Off by default
 * because it sends scripts and references, not just SKILL.md.
 */
function PrereviewRow({ state, providerLabel, onSaved }: { state: AiState["prereview"]; providerLabel: string | null; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = async (next: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/admin/ai/prereview", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: next }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      onSaved();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)" }} data-testid="ai-prereview-row">
      <h3 style={{ fontSize: 14, margin: "0 0 6px" }}>Pre-review proposals</h3>
      <p style={{ fontSize: 13, color: "var(--muted)", margin: "0 0 8px", lineHeight: 1.5 }}>
        Sends each submitted skill’s SKILL.md, scripts and references to {providerLabel ?? "the provider"} and shows reviewers
        what it finds (prompt injection, tool permissions, unsafe shell, exposed secrets, description mismatches). Advisory —
        it never blocks accept or publish.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Switch label="AI pre-review" checked={state.enabled} disabled={busy} onChange={(next) => void toggle(next)} />
        <span style={{ fontSize: 12.5, color: "var(--faint)" }} data-testid="ai-prereview-row-status">
          {state.enabled && !state.effective ? "On — waiting for the AI integration · " : ""}
          {formatCount(state.pending)} pending · {formatCount(state.failed24h)} failed in the last 24 h
        </span>
      </div>
      {err && <p role="alert" style={{ fontSize: 13, margin: "8px 0 0", color: "var(--danger, crimson)" }}>{err}</p>}
    </div>
  );
}

/**
 * §40.14 the end-user display name: its own Save, independent of the provider form — usable with
 * no provider configured and without AI_TOKEN_ENC_KEY, kept on Remove integration.
 */
function DisplayNameRow({ saved, onSaved }: { saved: string; onSaved: () => void }) {
  const [value, setValue] = useState(saved === "AI" ? "" : saved);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  useEffect(() => setValue(saved === "AI" ? "" : saved), [saved]);
  const dirty = value.trim() !== (saved === "AI" ? "" : saved);
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/admin/ai/display-name", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: value }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setMsg({ tone: "ok", text: `Saved — end users now see “${j.displayName}”.` });
      onSaved();
    } catch (e) {
      setMsg({ tone: "danger", text: String((e as Error).message ?? e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)" }} data-testid="ai-display-name">
      <h3 style={{ fontSize: 14, margin: "0 0 6px" }}>Display name</h3>
      <p style={{ fontSize: 13, color: "var(--muted)", margin: "0 0 8px", lineHeight: 1.5 }}>
        The word end users see in place of “AI” — e.g. <em>Draft improvements with Aria</em>. Leave empty for “AI”. Administration pages keep saying “AI”.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          className="input"
          style={{ maxWidth: 260 }}
          value={value}
          maxLength={24}
          placeholder="AI"
          aria-label="AI display name"
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="button" className="btn btn-sm" disabled={busy || !dirty} onClick={() => void save()} data-testid="ai-display-name-save">
          {busy ? "saving…" : "Save name"}
        </button>
      </div>
      {msg && (
        <p role="status" style={{ fontSize: 13, margin: "8px 0 0", color: msg.tone === "ok" ? "var(--ok, var(--muted))" : "var(--danger, crimson)" }}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

/** A stored override as the field shows it ("" = the default, shown as the placeholder). */
const fieldOf = (ms: number | null, unitMs: number) => (ms === null ? "" : String(ms / unitMs));

/**
 * §40.15 the timeouts: a seconds field per registered feature and a minutes field for the draft run
 * cap. Blank = the default (its placeholder). Its own Save, independent of the provider form —
 * usable with no provider configured and without AI_TOKEN_ENC_KEY, kept on Remove integration.
 */
function TimeoutsRow({ saved, onSaved }: { saved: AiTimeoutsView; onSaved: () => void }) {
  const initial = useCallback(
    () => ({
      calls: Object.fromEntries(saved.features.map((f) => [f.key, fieldOf(f.overrideMs, 1000)])) as Record<string, string>,
      cap: fieldOf(saved.draftRunCap.overrideMs, 60_000),
    }),
    [saved],
  );
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  useEffect(() => setForm(initial()), [initial]);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial());
  const blank = Object.values(form.calls).every((v) => v.trim() === "") && form.cap.trim() === "";

  const save = async () => {
    setMsg(null);
    const toMs = (v: string, unitMs: number): number | null | undefined => {
      const t = v.trim();
      if (t === "") return null;
      return /^\d+$/.test(t) ? Number(t) * unitMs : undefined;
    };
    const calls: Record<string, number | null> = {};
    for (const f of saved.features) {
      const ms = toMs(form.calls[f.key] ?? "", 1000);
      if (ms === undefined) return setMsg({ tone: "danger", text: `${f.label}: enter a whole number of seconds, or leave it empty for the default.` });
      calls[f.key] = ms;
    }
    const draftRunCapMs = toMs(form.cap, 60_000);
    if (draftRunCapMs === undefined) return setMsg({ tone: "danger", text: "Draft run cap: enter a whole number of minutes, or leave it empty for the default." });
    setBusy(true);
    try {
      const r = await fetch("/api/admin/ai/timeouts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ calls, draftRunCapMs }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail ?? j.error ?? `HTTP ${r.status}`);
      setMsg({ tone: "ok", text: "Saved — new calls use these timeouts." });
      onSaved();
    } catch (e) {
      setMsg({ tone: "danger", text: String((e as Error).message ?? e) });
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, testid: string, value: string, placeholder: string, unit: string, min: number, max: number, onChange: (v: string) => void) => (
    <label key={testid} style={{ display: "contents" }}>
      <span style={{ fontSize: 13 }}>{label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          className="input"
          style={{ width: 96 }}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={value}
          placeholder={placeholder}
          aria-label={`${label} (${unit})`}
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testid}
        />
        <span className="muted" style={{ fontSize: 12 }}>{unit} · default {placeholder}</span>
      </span>
    </label>
  );

  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)" }} data-testid="ai-timeouts">
      <h3 style={{ fontSize: 14, margin: "0 0 6px" }}>Timeouts</h3>
      <p style={{ fontSize: 13, color: "var(--muted)", margin: "0 0 10px", lineHeight: 1.5 }}>
        How long skilly waits for the provider on each call ({AI_CALL_TIMEOUT_MIN_MS / 1000}–{AI_CALL_TIMEOUT_MAX_MS / 1000} s; a failed call is retried
        once, so one call can take up to twice this), and how long a whole quality-draft run may last ({AI_DRAFT_RUN_CAP_MIN_MS / 60_000}–
        {AI_DRAFT_RUN_CAP_MAX_MS / 60_000} min). Leave a field empty for its default. Calls already running keep their timeout.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, max-content) auto", gap: "8px 16px", alignItems: "center" }}>
        {saved.features.map((f) =>
          row(f.label, `ai-timeout-${f.key}`, form.calls[f.key] ?? "", String(f.defaultMs / 1000), "s", AI_CALL_TIMEOUT_MIN_MS / 1000, AI_CALL_TIMEOUT_MAX_MS / 1000, (v) =>
            setForm((p) => ({ ...p, calls: { ...p.calls, [f.key]: v } })),
          ),
        )}
        {row("Draft run cap", "ai-timeout-draft-run-cap", form.cap, String(saved.draftRunCap.defaultMs / 60_000), "min", AI_DRAFT_RUN_CAP_MIN_MS / 60_000, AI_DRAFT_RUN_CAP_MAX_MS / 60_000, (v) =>
          setForm((p) => ({ ...p, cap: v })),
        )}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
        <button type="button" className="btn btn-sm" disabled={busy || !dirty} onClick={() => void save()} data-testid="ai-timeouts-save">
          {busy ? "saving…" : "Save timeouts"}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={busy || blank}
          onClick={() => setForm((p) => ({ calls: Object.fromEntries(Object.keys(p.calls).map((k) => [k, ""])), cap: "" }))}
          data-testid="ai-timeouts-reset"
        >
          Reset to defaults
        </button>
      </div>
      {msg && (
        <p role="status" style={{ fontSize: 13, margin: "8px 0 0", color: msg.tone === "ok" ? "var(--ok, var(--muted))" : "var(--danger, crimson)" }}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
