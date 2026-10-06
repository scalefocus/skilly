// The §40 AI integration: one platform-level LLM provider connection (Open WebUI or the
// Anthropic API) that skilly features call through a single helper. SERVER-ONLY — node:crypto
// inside (the token is AES-256-GCM-encrypted under AI_TOKEN_ENC_KEY, same `v1:` format as the
// §12 email tokens); exported via "@skilly/shared/ai", never from the client-reachable index.
//
// DB access is injected as a minimal pg-compatible shape (the email-graph pattern) so web and
// worker share one implementation and tests run against fakes. The token never reaches a log, an
// audit payload, a system_event or an error message; it is only ever sent to the stored base URL.
// SKILLY_SPEC.md §40.
import { decryptToken, encryptToken, parseEmailTokenKey } from "./email-crypto.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface AiDb {
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

// ── Providers, features, errors ──────────────────────────────────────────────────────────────

export type AiProvider = "openwebui" | "anthropic";
export const AI_PROVIDERS: readonly AiProvider[] = ["openwebui", "anthropic"];
export const AI_PROVIDER_LABELS: Record<AiProvider, string> = { openwebui: "Open WebUI", anthropic: "Anthropic API" };
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
export const AI_TOKEN_ENC_KEY_ENV = "AI_TOKEN_ENC_KEY";

/** Parse + validate the base64 AI key (32 bytes). Null when unset/invalid. */
export function parseAiTokenKey(keyB64: string | undefined): Buffer | null {
  return parseEmailTokenKey(keyB64);
}

export function isAiProvider(v: unknown): v is AiProvider {
  return typeof v === "string" && (AI_PROVIDERS as readonly string[]).includes(v);
}

/**
 * An AI task. Every task registers here with the data it sends to the provider (§40.10 egress
 * rule) and its spec section; the admin card lists the registry. Calling the helper with an
 * unregistered key throws before any network call.
 */
export interface AiFeature {
  key: string;
  label: string;
  /** Exactly what data this task sends to the provider. */
  egress: string;
  /** The spec section that defines the task, e.g. "§41". */
  spec: string;
}

/** v1 ships no AI task — the registry is empty (§40.7). */
export const AI_FEATURES: readonly AiFeature[] = [];
/** The reserved feature key the admin connectivity test records its usage under. */
export const AI_TEST_FEATURE = "test";

export type AiErrorCode =
  | "ai_not_configured"
  | "ai_disabled"
  | "ai_key_missing"
  | "ai_token_undecryptable"
  | "ai_unknown_feature"
  | "ai_timeout"
  | "ai_provider_error"
  | "ai_invalid_json";

export class AiError extends Error {
  readonly code: AiErrorCode;
  /** The provider's HTTP status, for ai_provider_error responses (absent on network errors). */
  readonly httpStatus?: number;
  /** Seconds the provider asked us to wait (Retry-After), when it sent one. */
  readonly retryAfter?: string | null;
  constructor(code: AiErrorCode, message: string, opts: { httpStatus?: number; retryAfter?: string | null } = {}) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.httpStatus = opts.httpStatus;
    this.retryAfter = opts.retryAfter ?? null;
  }
}

// ── Validation ───────────────────────────────────────────────────────────────────────────────

export const AI_BASE_URL_MAX = 500;
export const AI_MODEL_MAX = 200;
export const AI_TOKEN_MAX = 4096;
export const AI_MAX_TOKENS_LIMIT = 8192;

/**
 * Normalize an admin-entered base URL (§40.2): absolute http(s), ≤ 500 chars, no userinfo /
 * query / fragment, trailing slashes stripped. Blank = the Anthropic default; Open WebUI requires one.
 */
export function normalizeAiBaseUrl(provider: AiProvider, raw: string | null | undefined): { ok: true; url: string } | { ok: false; error: string } {
  const s = (raw ?? "").trim();
  if (!s) {
    if (provider === "anthropic") return { ok: true, url: ANTHROPIC_DEFAULT_BASE_URL };
    return { ok: false, error: "a base URL is required for Open WebUI" };
  }
  if (s.length > AI_BASE_URL_MAX) return { ok: false, error: `the base URL must be at most ${AI_BASE_URL_MAX} characters` };
  if (s.includes("?") || s.includes("#")) return { ok: false, error: "the base URL must not contain a query string or fragment" };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "the base URL is not a valid absolute URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "the base URL must start with http:// or https://" };
  if (u.username || u.password) return { ok: false, error: "the base URL must not contain credentials" };
  const path = u.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${u.protocol}//${u.host}${path}` };
}

/** Validate a model id (free text or from the list). */
export function validateAiModel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim();
  return m.length >= 1 && m.length <= AI_MODEL_MAX && !/[\r\n]/.test(m) ? m : null;
}

/** The token's last 4 characters, for the admin card (never more). */
export function tokenLast4(token: string): string {
  return token.length <= 4 ? "" : token.slice(-4);
}

/**
 * One line, ≤ 300 chars, with the token (if known) redacted — the only shape provider error
 * text may take on its way to the admin card, ai_usage or the System log.
 */
export function sanitizeAiError(msg: string, token?: string | null): string {
  let s = String(msg);
  if (token && token.length >= 4) s = s.split(token).join("***");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 300 ? `${s.slice(0, 299)}…` : s;
}

// ── Wire format (§40.2) ──────────────────────────────────────────────────────────────────────

export interface AiConnection {
  provider: AiProvider;
  /** Normalized base URL (normalizeAiBaseUrl). */
  baseUrl: string;
  token: string;
}

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiRequestSpec {
  url: string;
  /** The endpoint path, without host or query — what the System log records. */
  path: string;
  init: { method: string; headers: Record<string, string>; body?: string };
}

function authHeaders(c: AiConnection): Record<string, string> {
  return c.provider === "anthropic"
    ? { "x-api-key": c.token, "anthropic-version": ANTHROPIC_VERSION }
    : { authorization: `Bearer ${c.token}` };
}

export function buildCompletionRequest(
  c: AiConnection,
  r: { model: string; system?: string; messages: AiMessage[]; maxTokens: number },
): AiRequestSpec {
  const headers = { ...authHeaders(c), "content-type": "application/json", accept: "application/json" };
  if (c.provider === "anthropic") {
    const path = "/v1/messages";
    const body: Record<string, unknown> = { model: r.model, max_tokens: r.maxTokens, messages: r.messages };
    if (r.system) body.system = r.system;
    return { url: c.baseUrl + path, path, init: { method: "POST", headers, body: JSON.stringify(body) } };
  }
  const path = "/api/chat/completions";
  const messages = r.system ? [{ role: "system", content: r.system }, ...r.messages] : r.messages;
  const body = { model: r.model, messages, max_tokens: r.maxTokens, stream: false };
  return { url: c.baseUrl + path, path, init: { method: "POST", headers, body: JSON.stringify(body) } };
}

export interface AiCompletionParsed {
  text: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
}

/** Parse a provider completion body; throws ai_provider_error on an unexpected shape. */
export function parseCompletionResponse(provider: AiProvider, body: unknown): AiCompletionParsed {
  const b = (body ?? {}) as Record<string, any>;
  if (provider === "anthropic") {
    if (!Array.isArray(b.content)) throw new AiError("ai_provider_error", "unexpected response from the provider (no content)");
    const text = b.content.filter((x: any) => x && x.type === "text" && typeof x.text === "string").map((x: any) => x.text).join("");
    return {
      text,
      model: typeof b.model === "string" ? b.model : null,
      inputTokens: intOrNull(b.usage?.input_tokens),
      outputTokens: intOrNull(b.usage?.output_tokens),
    };
  }
  const content = b.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new AiError("ai_provider_error", "unexpected response from the provider (no choices)");
  return {
    text: content,
    model: typeof b.model === "string" ? b.model : null,
    inputTokens: intOrNull(b.usage?.prompt_tokens),
    outputTokens: intOrNull(b.usage?.completion_tokens),
  };
}

export function buildModelsRequest(c: AiConnection): AiRequestSpec {
  const path = c.provider === "anthropic" ? "/v1/models" : "/api/models";
  const query = c.provider === "anthropic" ? "?limit=1000" : "";
  return { url: c.baseUrl + path + query, path, init: { method: "GET", headers: { ...authHeaders(c), accept: "application/json" } } };
}

export const AI_MODELS_MAX = 1000;

/** Model ids from a models-list body: sorted, de-duplicated, ≤ 1000. */
export function parseModelsResponse(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new AiError("ai_provider_error", "unexpected response from the provider (no model list)");
  const ids = new Set<string>();
  for (const m of data) {
    const id = (m as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.trim()) ids.add(id.trim());
  }
  return [...ids].sort((a, b) => a.localeCompare(b)).slice(0, AI_MODELS_MAX);
}

/** Pull a human error line out of a provider error body (Anthropic, OpenAI and Open WebUI shapes). */
export function providerErrorText(body: unknown, rawText: string): string {
  const b = (body ?? null) as Record<string, any> | null;
  const cand = [b?.error?.message, typeof b?.error === "string" ? b.error : null, b?.detail, b?.message].find(
    (x) => typeof x === "string" && x.trim(),
  );
  if (typeof cand === "string") return cand;
  if (b?.detail && typeof b.detail === "object") return JSON.stringify(b.detail);
  return rawText.trim() || "no error detail";
}

// ── JSON mode ────────────────────────────────────────────────────────────────────────────────

export const AI_JSON_INSTRUCTION = "Respond with a single JSON value only — no prose and no code fences.";

/**
 * Strip one surrounding ``` / ```json fence. Plain string slicing, NOT a regex: model output is
 * untrusted, and a fence pattern with optional whitespace around a lazy body backtracks
 * polynomially on input like "```" + many spaces (js/polynomial-redos).
 */
export function stripCodeFence(text: string): string {
  const s = text.trim();
  if (s.length < 6 || !s.startsWith("```") || !s.endsWith("```")) return s;
  const inner = s.slice(3, -3);
  const nl = inner.indexOf("\n");
  if (nl === -1) return inner.trim();
  // The opening line may carry only a language tag (```json); anything else is content.
  return (/^[A-Za-z0-9_-]*$/.test(inner.slice(0, nl).trim()) ? inner.slice(nl + 1) : inner).trim();
}

/** Strip one surrounding code fence and parse; ai_invalid_json on failure. */
export function parseAiJson(text: string): unknown {
  const s = stripCodeFence(text);
  try {
    return JSON.parse(s);
  } catch {
    throw new AiError("ai_invalid_json", "the model did not return valid JSON");
  }
}

// ── Transport ────────────────────────────────────────────────────────────────────────────────

export const AI_RESPONSE_MAX_BYTES = 1024 * 1024;
export const AI_CALL_TIMEOUT_MS = 60_000;
export const AI_TEST_TIMEOUT_MS = 20_000;
export const AI_RETRY_AFTER_CAP_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new AiError("ai_provider_error", "the provider response exceeded 1 MB");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One HTTP exchange with the provider: redirects are NOT followed (a 3xx must never carry the
 * token elsewhere), the body is capped at 1 MB, and every failure is an AiError whose message is
 * already sanitized (token-redacted, one line).
 */
export async function providerFetch(
  spec: AiRequestSpec,
  opts: { timeoutMs: number; token: string; fetchImpl?: typeof fetch },
): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    let res: Response;
    try {
      res = await f(spec.url, { ...spec.init, redirect: "manual", signal: ctrl.signal });
    } catch (err) {
      if (ctrl.signal.aborted) throw new AiError("ai_timeout", `the provider did not answer within ${Math.round(opts.timeoutMs / 1000)}s`);
      throw new AiError("ai_provider_error", sanitizeAiError(`could not reach the provider: ${(err as Error)?.message ?? err}`, opts.token));
    }
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      throw new AiError("ai_provider_error", "the provider answered with a redirect, which is not followed — check the base URL", { httpStatus: res.status || 302 });
    }
    const raw = await readCapped(res, AI_RESPONSE_MAX_BYTES);
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      throw new AiError("ai_provider_error", sanitizeAiError(`HTTP ${res.status}: ${providerErrorText(body, raw)}`, opts.token), {
        httpStatus: res.status,
        retryAfter: res.headers.get("retry-after"),
      });
    }
    if (body === null) throw new AiError("ai_provider_error", "the provider returned a non-JSON response");
    return body;
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (ctrl.signal.aborted) throw new AiError("ai_timeout", `the provider did not answer within ${Math.round(opts.timeoutMs / 1000)}s`);
    throw new AiError("ai_provider_error", sanitizeAiError(String((err as Error)?.message ?? err), opts.token));
  } finally {
    clearTimeout(timer);
  }
}

/** §40.7 retry policy: once on a network error, 429 or 5xx — never on a timeout or another 4xx. */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof AiError) || err.code !== "ai_provider_error") return false;
  if (err.httpStatus === undefined) return true; // network error
  return err.httpStatus === 429 || err.httpStatus >= 500;
}

/** Delay before the retry: Retry-After (seconds or HTTP date) capped at 10 s, else 1 s. */
export function retryDelayMs(retryAfter: string | null | undefined, now = Date.now()): number {
  if (!retryAfter) return DEFAULT_RETRY_DELAY_MS;
  const secs = Number(retryAfter);
  let ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(retryAfter) - now;
  if (!Number.isFinite(ms) || ms < 0) ms = DEFAULT_RETRY_DELAY_MS;
  return Math.min(ms, AI_RETRY_AFTER_CAP_MS);
}

// ── Test & model list (no DB) ────────────────────────────────────────────────────────────────

export interface AiTestResult {
  ok: boolean;
  latencyMs: number;
  /** The model id the provider echoed back (or the requested one when it didn't). */
  model: string | null;
  error: string | null;
  errorCode: AiErrorCode | null;
  httpStatus: number | null;
}

/** §40.5: a minimal completion, 20 s timeout, no retry. Pass = a 2xx with a parseable response. */
export async function runAiTest(
  c: AiConnection & { model: string },
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<AiTestResult> {
  const started = Date.now();
  const spec = buildCompletionRequest(c, {
    model: c.model,
    system: "You are a connectivity check.",
    messages: [{ role: "user", content: "Reply with the single word OK." }],
    maxTokens: 16,
  });
  try {
    const body = await providerFetch(spec, { timeoutMs: opts.timeoutMs ?? AI_TEST_TIMEOUT_MS, token: c.token, fetchImpl: opts.fetchImpl });
    const parsed = parseCompletionResponse(c.provider, body);
    return { ok: true, latencyMs: Date.now() - started, model: parsed.model ?? c.model, error: null, errorCode: null, httpStatus: null };
  } catch (err) {
    const e = err instanceof AiError ? err : new AiError("ai_provider_error", sanitizeAiError(String(err), c.token));
    return { ok: false, latencyMs: Date.now() - started, model: null, error: e.message, errorCode: e.code, httpStatus: e.httpStatus ?? null };
  }
}

/** The provider's model ids (§40.2); throws AiError on failure. */
export async function listAiModels(c: AiConnection, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<string[]> {
  const body = await providerFetch(buildModelsRequest(c), { timeoutMs: opts.timeoutMs ?? AI_TEST_TIMEOUT_MS, token: c.token, fetchImpl: opts.fetchImpl });
  return parseModelsResponse(body);
}

// ── Stored config ────────────────────────────────────────────────────────────────────────────

export interface AiConfigRow {
  enabled: boolean;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  tokenEnc: string;
  tokenLast4: string;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  lastTestLatencyMs: number | null;
  lastCallAt: string | null;
  lastCallOk: boolean | null;
  lastCallError: string | null;
  updatedByUserId: string | null;
  updatedAt: string;
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

/** The single config row, or null when not configured. */
export async function loadAiConfig(db: AiDb): Promise<AiConfigRow | null> {
  const { rows } = await db.query(
    `select enabled, provider, base_url, model, token_enc, token_last4, last_test_at, last_test_ok, last_test_error,
            last_test_latency_ms, last_call_at, last_call_ok, last_call_error, updated_by_user_id, updated_at
       from ai_integration where id = 1`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    enabled: r.enabled,
    provider: r.provider,
    baseUrl: r.base_url,
    model: r.model,
    tokenEnc: r.token_enc,
    tokenLast4: r.token_last4,
    lastTestAt: iso(r.last_test_at),
    lastTestOk: r.last_test_ok,
    lastTestError: r.last_test_error,
    lastTestLatencyMs: r.last_test_latency_ms,
    lastCallAt: iso(r.last_call_at),
    lastCallOk: r.last_call_ok,
    lastCallError: r.last_call_error,
    updatedByUserId: r.updated_by_user_id,
    updatedAt: iso(r.updated_at)!,
  };
}

/** Decrypt the stored token; null when the key is missing or can't open it. */
export function decryptAiToken(row: Pick<AiConfigRow, "tokenEnc">, key: Buffer | null): string | null {
  if (!key) return null;
  try {
    return decryptToken(row.tokenEnc, key);
  } catch {
    return null;
  }
}

export function encryptAiToken(token: string, key: Buffer): string {
  return encryptToken(token, key);
}

// ── Status (§40.8) ───────────────────────────────────────────────────────────────────────────

export type AiStatus = "not_configured" | "off" | "operational" | "failing";

export interface AiStatusView {
  status: AiStatus;
  reason: string | null;
  at: string | null;
}

/**
 * Not configured / Off / Failing / Operational. Failing = enabled and either the token can't be
 * decrypted, or the MORE RECENT of the last saved-config test and the last runtime call failed.
 */
export function deriveAiStatus(
  row: Pick<AiConfigRow, "enabled" | "lastTestAt" | "lastTestOk" | "lastTestError" | "lastCallAt" | "lastCallOk" | "lastCallError"> | null,
  tokenDecryptable: boolean,
): AiStatusView {
  if (!row) return { status: "not_configured", reason: null, at: null };
  if (!row.enabled) return { status: "off", reason: null, at: null };
  if (!tokenDecryptable) return { status: "failing", reason: "can't decrypt token — replace it", at: null };
  const testT = row.lastTestAt ? Date.parse(row.lastTestAt) : -Infinity;
  const callT = row.lastCallAt ? Date.parse(row.lastCallAt) : -Infinity;
  if (testT === -Infinity && callT === -Infinity) return { status: "operational", reason: null, at: null };
  const useCall = callT > testT;
  const ok = useCall ? row.lastCallOk : row.lastTestOk;
  const at = useCall ? row.lastCallAt : row.lastTestAt;
  if (ok) return { status: "operational", reason: null, at };
  return { status: "failing", reason: (useCall ? row.lastCallError : row.lastTestError) ?? "unknown error", at };
}

// ── Usage & failure bookkeeping ──────────────────────────────────────────────────────────────

export async function recordAiUsage(
  db: AiDb,
  u: {
    feature: string;
    userId: string | null;
    provider: AiProvider;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number;
    ok: boolean;
    errorCode: string | null;
  },
): Promise<void> {
  await db.query(
    `insert into ai_usage (feature, user_id, provider, model, input_tokens, output_tokens, latency_ms, ok, error_code)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [u.feature, u.userId, u.provider, u.model.slice(0, AI_MODEL_MAX), u.inputTokens, u.outputTokens, Math.max(0, Math.round(u.latencyMs)), u.ok, u.errorCode],
  );
}

async function noteCall(db: AiDb, ok: boolean, error: string | null): Promise<void> {
  await db.query(`update ai_integration set last_call_at = now(), last_call_ok = $1, last_call_error = $2 where id = 1`, [ok, error]);
}

const SYSTEM_LOG_STATUS: Partial<Record<AiErrorCode, number>> = {
  ai_provider_error: 502,
  ai_invalid_json: 502,
  ai_timeout: 504,
  ai_token_undecryptable: 500,
};

/**
 * §40.8: a runtime failure writes at most ONE system_event per 15 minutes platform-wide. The
 * conditional UPDATE is the claim, so concurrent failures in web and worker never double-log.
 */
export async function logAiFailure(
  db: AiDb,
  e: { source: "web" | "worker"; feature: string; path: string; userId: string | null; code: AiErrorCode; message: string; durationMs: number | null },
): Promise<boolean> {
  const status = SYSTEM_LOG_STATUS[e.code];
  if (!status) return false;
  const claim = await db.query(
    `update ai_integration set last_failure_logged_at = now()
      where id = 1 and (last_failure_logged_at is null or last_failure_logged_at < now() - interval '15 minutes')`,
  );
  if (!claim.rowCount) return false;
  await db.query(
    `insert into system_event (status, method, route, path, user_id, actor_name, actor_email, error_code, message, duration_ms, source)
     values ($1, 'AI', $2, $3, $4,
             (select display_name from users where id = $4),
             (select email from users where id = $4),
             $5, $6, $7, $8)`,
    [status, `ai:${e.feature}`.slice(0, 300), e.path.slice(0, 500), e.userId, e.code, sanitizeAiError(e.message), e.durationMs, e.source],
  );
  return true;
}

// ── The helper (§40.7) ───────────────────────────────────────────────────────────────────────

export interface AiEnv {
  /** Parsed AI_TOKEN_ENC_KEY. */
  key: Buffer | null;
  /** Which process is calling — the System log's `source`. */
  source: "web" | "worker";
  /** The feature registry (defaults to AI_FEATURES; tests inject their own). */
  features?: readonly AiFeature[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AiCompleteOptions {
  feature: string;
  /** The person the call runs for; omit for system/background work. */
  userId?: string | null;
  system?: string;
  messages: AiMessage[];
  maxTokens: number;
  json?: boolean;
}

export interface AiCompleteResult {
  text: string;
  json?: unknown;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

/** True when the integration is configured, enabled and its token decrypts — gate AI affordances on it. */
export async function aiAvailable(db: AiDb, env: Pick<AiEnv, "key">): Promise<boolean> {
  const row = await loadAiConfig(db);
  return Boolean(row?.enabled && decryptAiToken(row, env.key) !== null);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function bestEffort(p: Promise<unknown>): Promise<void> {
  return p.then(
    () => {},
    (err) => console.error(JSON.stringify({ level: "warn", msg: "ai bookkeeping failed", err: String((err as Error)?.message ?? err) })),
  );
}

/**
 * Call the configured provider. The config is read on EVERY call (one single-row read, no cache),
 * so enable/disable, rotation and removal take effect immediately in both processes.
 */
export async function aiComplete(db: AiDb, env: AiEnv, o: AiCompleteOptions): Promise<AiCompleteResult> {
  const features = env.features ?? AI_FEATURES;
  if (o.feature === AI_TEST_FEATURE || !features.some((f) => f.key === o.feature)) {
    throw new AiError("ai_unknown_feature", `"${o.feature}" is not a registered AI feature`);
  }
  if (!Array.isArray(o.messages) || o.messages.length === 0) throw new Error("aiComplete: messages must be a non-empty array");
  if (!Number.isInteger(o.maxTokens) || o.maxTokens < 1 || o.maxTokens > AI_MAX_TOKENS_LIMIT) {
    throw new Error(`aiComplete: maxTokens must be an integer 1–${AI_MAX_TOKENS_LIMIT}`);
  }

  const row = await loadAiConfig(db);
  if (!row) throw new AiError("ai_not_configured", "the AI integration is not configured");
  if (!row.enabled) throw new AiError("ai_disabled", "the AI integration is disabled");
  if (!env.key) throw new AiError("ai_key_missing", `${AI_TOKEN_ENC_KEY_ENV} is not set`);
  const userId = o.userId ?? null;
  const spec0 = { model: row.model, system: o.json ? [o.system, AI_JSON_INSTRUCTION].filter(Boolean).join("\n\n") : o.system, messages: o.messages, maxTokens: o.maxTokens };

  const token = decryptAiToken(row, env.key);
  if (token === null) {
    const err = new AiError("ai_token_undecryptable", "the stored AI token can't be decrypted — replace it on the Administration page");
    await bestEffort(noteCall(db, false, `${err.code}: ${err.message}`));
    await bestEffort(logAiFailure(db, { source: env.source, feature: o.feature, path: buildCompletionRequest({ provider: row.provider, baseUrl: row.baseUrl, token: "" }, spec0).path, userId, code: err.code, message: err.message, durationMs: null }));
    throw err;
  }

  const conn: AiConnection = { provider: row.provider, baseUrl: row.baseUrl, token };
  const spec = buildCompletionRequest(conn, spec0);
  const sleep = env.sleep ?? defaultSleep;
  const started = Date.now();
  let parsed: AiCompletionParsed | null = null;
  let failure: AiError | null = null;
  let json: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const body = await providerFetch(spec, { timeoutMs: env.timeoutMs ?? AI_CALL_TIMEOUT_MS, token, fetchImpl: env.fetchImpl });
      parsed = parseCompletionResponse(row.provider, body);
      failure = null;
      break;
    } catch (err) {
      failure = err instanceof AiError ? err : new AiError("ai_provider_error", sanitizeAiError(String(err), token));
      if (attempt === 0 && isRetryable(failure)) {
        await sleep(retryDelayMs(failure.retryAfter));
        continue;
      }
      break;
    }
  }
  if (parsed && o.json) {
    try {
      json = parseAiJson(parsed.text);
    } catch (err) {
      failure = err as AiError;
    }
  }
  const latencyMs = Date.now() - started;
  const model = parsed?.model ?? row.model;

  await bestEffort(
    recordAiUsage(db, {
      feature: o.feature,
      userId,
      provider: row.provider,
      model,
      inputTokens: parsed?.inputTokens ?? null,
      outputTokens: parsed?.outputTokens ?? null,
      latencyMs,
      ok: failure === null,
      errorCode: failure?.code ?? null,
    }),
  );
  await bestEffort(noteCall(db, failure === null, failure ? `${failure.code}: ${failure.message}` : null));

  if (failure) {
    await bestEffort(logAiFailure(db, { source: env.source, feature: o.feature, path: spec.path, userId, code: failure.code, message: failure.message, durationMs: latencyMs }));
    throw failure;
  }
  const out: AiCompleteResult = { text: parsed!.text, model, inputTokens: parsed!.inputTokens, outputTokens: parsed!.outputTokens, latencyMs };
  if (o.json) out.json = json;
  return out;
}

// ── Housekeeping ─────────────────────────────────────────────────────────────────────────────

export const AI_USAGE_RETENTION = "365 days";

/** Leader-only worker sweep: drop ai_usage rows older than 365 days. Returns the count. */
export async function pruneAiUsage(db: AiDb): Promise<number> {
  const r = await db.query(`delete from ai_usage where created_at < now() - $1::interval`, [AI_USAGE_RETENTION]);
  return r.rowCount ?? 0;
}
