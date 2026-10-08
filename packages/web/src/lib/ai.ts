// Web-side helpers for the §40 AI integration: the Administration card's status, model list,
// connectivity test, save-runs-test, enable/disable and remove — plus the pool-bound helper web
// features call (aiComplete / aiAvailable). Every admin caller is a platform-admin-only route
// (re-verified there). The provider token is handled only through @skilly/shared/ai: encrypted
// at rest, never logged, never in audit payloads, never returned to the browser, and only ever
// sent to the stored base URL. SKILLY_SPEC.md §40.
import { loadPrereviewSetting, prereviewCounts } from "@skilly/shared";
import { pool } from "./db";
import { appendAudit } from "./audit";
import { getPlatformSettings } from "./settings";
import {
  AI_FEATURES,
  AI_PROVIDER_LABELS,
  AI_TEST_FEATURE,
  AI_TOKEN_MAX,
  aiAvailable as sharedAiAvailable,
  aiComplete as sharedAiComplete,
  decryptAiToken,
  deriveAiStatus,
  encryptAiToken,
  isAiProvider,
  listAiModels,
  loadAiConfig,
  normalizeAiBaseUrl,
  parseAiTokenKey,
  recordAiUsage,
  runAiTest,
  tokenLast4,
  validateAiModel,
  AiError,
  type AiCompleteOptions,
  type AiCompleteResult,
  type AiConfigRow,
  type AiProvider,
  type AiStatus,
  type AiTestResult,
} from "@skilly/shared/ai";
import {
  AI_TIMEOUTS_SETTING,
  aiTimeoutOverridesEmpty,
  aiTimeoutsView,
  effectiveAiDraftRunCapMs,
  parseAiTimeoutOverrides,
  validateAiTimeoutsInput,
  type AiTimeoutOverrides,
  type AiTimeoutsView,
} from "@skilly/shared/ai-timeouts";

/** Override point for tests (a local stub provider); production uses global fetch. */
let fetchImpl: typeof fetch | undefined;
export function __setAiFetchForTests(f: typeof fetch | undefined): void {
  fetchImpl = f;
}

function aiKey(): Buffer | null {
  return parseAiTokenKey(process.env.AI_TOKEN_ENC_KEY);
}

// ── The helper, bound to the web pool (for future web AI tasks) ─────────────────────────────

export function aiComplete(o: AiCompleteOptions): Promise<AiCompleteResult> {
  return sharedAiComplete(pool, { key: aiKey(), source: "web", fetchImpl }, o);
}

export function aiAvailable(): Promise<boolean> {
  return sharedAiAvailable(pool, { key: aiKey() });
}

// ── Status (GET /api/admin/ai) ───────────────────────────────────────────────────────────────

export interface AiUsageByFeature {
  feature: string;
  label: string;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AiAdminStatus {
  keyConfigured: boolean;
  configured: boolean;
  enabled: boolean;
  provider: AiProvider | null;
  providerLabel: string | null;
  baseUrl: string | null;
  model: string | null;
  tokenLast4: string | null;
  tokenDecryptable: boolean;
  status: AiStatus;
  statusReason: string | null;
  statusAt: string | null;
  lastTest: { at: string | null; ok: boolean | null; latencyMs: number | null; error: string | null };
  /** Whether the toggle may switch on right now (§40.6). */
  canEnable: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
  usage30d: { calls: number; failed: number; inputTokens: number; outputTokens: number; byFeature: AiUsageByFeature[] };
  features: { key: string; label: string; egress: string; spec: string }[];
  /** §40.14 the end-user AI display name (independent of the provider config). */
  displayName: string;
  /** §40.15 per-call timeouts and the draft run cap (independent of the provider config). */
  timeouts: AiTimeoutsView;
  /** §46.2 the AI pre-review switch and its queue (independent of the provider config). */
  prereview: { enabled: boolean; effective: boolean; pending: number; failed24h: number };
}

function featureLabel(key: string): string {
  if (key === AI_TEST_FEATURE) return "Test";
  return AI_FEATURES.find((f) => f.key === key)?.label ?? key;
}

export async function getAiAdminStatus(): Promise<AiAdminStatus> {
  const key = aiKey();
  const row = await loadAiConfig(pool);
  const decryptable = row ? decryptAiToken(row, key) !== null : false;
  const st = deriveAiStatus(row, decryptable);

  let updatedByName: string | null = null;
  if (row?.updatedByUserId) {
    const { rows } = await pool.query<{ display_name: string }>(`select display_name from users where id = $1`, [row.updatedByUserId]);
    updatedByName = rows[0]?.display_name ?? null;
  }

  const { rows: usage } = await pool.query<{ feature: string; calls: string; failed: string; input_tokens: string; output_tokens: string }>(
    `select feature,
            count(*)::text                                as calls,
            count(*) filter (where not ok)::text          as failed,
            coalesce(sum(input_tokens), 0)::text          as input_tokens,
            coalesce(sum(output_tokens), 0)::text         as output_tokens
       from ai_usage
      where created_at >= now() - interval '30 days'
      group by feature
      order by count(*) desc, feature`,
  );
  const byFeature = usage.map((u) => ({
    feature: u.feature,
    label: featureLabel(u.feature),
    calls: Number(u.calls),
    failed: Number(u.failed),
    inputTokens: Number(u.input_tokens),
    outputTokens: Number(u.output_tokens),
  }));
  const sum = (k: "calls" | "failed" | "inputTokens" | "outputTokens") => byFeature.reduce((n, f) => n + f[k], 0);

  return {
    keyConfigured: key !== null,
    configured: row !== null,
    enabled: row?.enabled ?? false,
    provider: row?.provider ?? null,
    providerLabel: row ? AI_PROVIDER_LABELS[row.provider] : null,
    baseUrl: row?.baseUrl ?? null,
    model: row?.model ?? null,
    tokenLast4: row?.tokenLast4 ?? null,
    tokenDecryptable: decryptable,
    status: st.status,
    statusReason: st.reason,
    statusAt: st.at,
    lastTest: { at: row?.lastTestAt ?? null, ok: row?.lastTestOk ?? null, latencyMs: row?.lastTestLatencyMs ?? null, error: row?.lastTestError ?? null },
    canEnable: Boolean(row && row.lastTestOk === true && decryptable),
    updatedAt: row?.updatedAt ?? null,
    updatedByName,
    usage30d: { calls: sum("calls"), failed: sum("failed"), inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), byFeature },
    features: AI_FEATURES.map((f) => ({ key: f.key, label: f.label, egress: f.egress, spec: f.spec })),
    displayName: (await getPlatformSettings(pool)).aiDisplayName,
    timeouts: aiTimeoutsView(AI_FEATURES, await loadAiTimeouts()),
    prereview: await prereviewAdminState(row?.enabled === true && decryptable),
  };
}

// ── Timeouts (§40.15) ────────────────────────────────────────────────────────────────────────

const FEATURE_KEYS = AI_FEATURES.map((f) => f.key);

/** The stored overrides as served (unknown features ignored, out-of-range values clamped). */
export async function loadAiTimeouts(): Promise<AiTimeoutOverrides> {
  const { rows } = await pool.query<{ value: unknown }>(`select value from platform_settings where key = $1`, [AI_TIMEOUTS_SETTING]);
  return parseAiTimeoutOverrides(rows[0]?.value, FEATURE_KEYS);
}

/** The §44.5 run cap a draft run starting now uses. */
export async function aiDraftRunCapMs(): Promise<number> {
  return effectiveAiDraftRunCapMs(await loadAiTimeouts());
}

/**
 * PUT /api/admin/ai/timeouts: the body is the complete set of overrides (absent / null = default).
 * Independent of the provider config — no test, no token, no AI_TOKEN_ENC_KEY needed. Only
 * overrides are stored; the row is deleted when none is left. An unchanged save writes and
 * audits nothing; otherwise audited as settings.updated.
 */
export async function saveAiTimeouts(body: unknown, userId: string): Promise<AiTimeoutsView | AiApiError> {
  const v = validateAiTimeoutsInput(body, AI_FEATURES);
  if (!v.ok) return { error: "invalid_timeout", detail: `${v.field}: ${v.error}`, status: 422 };
  const before = await loadAiTimeouts();
  const beforeView = aiTimeoutsView(AI_FEATURES, before);
  const afterView = aiTimeoutsView(AI_FEATURES, v.value);
  if (JSON.stringify(beforeView) === JSON.stringify(afterView)) return afterView;
  if (aiTimeoutOverridesEmpty(v.value)) {
    await pool.query(`delete from platform_settings where key = $1`, [AI_TIMEOUTS_SETTING]);
  } else {
    await pool.query(
      `insert into platform_settings (key, value, updated_by, updated_at) values ($1, $2::jsonb, $3, now())
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [AI_TIMEOUTS_SETTING, JSON.stringify(v.value), userId],
    );
  }
  await appendAudit(pool, {
    actorUserId: userId,
    action: "settings.updated",
    targetType: "platform_settings",
    targetId: AI_TIMEOUTS_SETTING,
    before: { aiTimeouts: before },
    after: { aiTimeouts: v.value },
  });
  return afterView;
}

// ── Form input → a connection (shared by models / test / save) ───────────────────────────────

export type AiApiError = { error: string; status: number; detail?: string };

interface ResolvedInput {
  provider: AiProvider;
  baseUrl: string;
  token: string;
  /** True when the token came from the form (not the stored one). */
  tokenFromForm: boolean;
  row: AiConfigRow | null;
}

/**
 * Validate provider / base URL / token. A blank token means "use the stored token", permitted
 * ONLY when provider and normalized base URL equal the saved config and the token decrypts
 * (§40.1 #7) — so the secret can never be steered to another host.
 */
async function resolveInput(body: Record<string, unknown>, key: Buffer): Promise<ResolvedInput | AiApiError> {
  if (!isAiProvider(body.provider)) return { error: "provider must be openwebui or anthropic", status: 422 };
  const provider = body.provider;
  const url = normalizeAiBaseUrl(provider, typeof body.baseUrl === "string" ? body.baseUrl : null);
  if (!url.ok) return { error: "invalid_base_url", detail: url.error, status: 422 };
  const rawToken = typeof body.token === "string" ? body.token.trim() : "";
  if (rawToken.length > AI_TOKEN_MAX) return { error: "invalid_token", detail: `the token must be at most ${AI_TOKEN_MAX} characters`, status: 422 };
  if (/\s/.test(rawToken)) return { error: "invalid_token", detail: "the token must not contain whitespace", status: 422 };
  const row = await loadAiConfig(pool);
  if (rawToken) return { provider, baseUrl: url.url, token: rawToken, tokenFromForm: true, row };
  if (!row || row.provider !== provider || row.baseUrl !== url.url) {
    return { error: "ai_token_required", detail: "enter the token — the stored one is only sent to the saved provider and base URL", status: 422 };
  }
  const stored = decryptAiToken(row, key);
  if (stored === null) return { error: "ai_token_required", detail: "the stored token can't be decrypted — enter a new one", status: 422 };
  return { provider, baseUrl: url.url, token: stored, tokenFromForm: false, row };
}

function keyOrError(): Buffer | AiApiError {
  return aiKey() ?? { error: "ai_key_missing", detail: "set AI_TOKEN_ENC_KEY (a 32-byte base64 key) on web and worker", status: 409 };
}

/** True for the lib's error shape (an AiTestResult also has an `error` field, so `"error" in r` won't narrow). */
export function isAiApiError(x: unknown): x is AiApiError {
  return typeof x === "object" && x !== null && "error" in x && "status" in x;
}

// ── POST /api/admin/ai/models ────────────────────────────────────────────────────────────────

export async function listModelsForForm(body: Record<string, unknown>): Promise<{ models: string[] } | AiApiError> {
  const key = keyOrError();
  if (isAiApiError(key)) return key;
  const input = await resolveInput(body, key);
  if (isAiApiError(input)) return input;
  try {
    return { models: await listAiModels({ provider: input.provider, baseUrl: input.baseUrl, token: input.token }, { fetchImpl }) };
  } catch (err) {
    const e = err instanceof AiError ? err : new AiError("ai_provider_error", String(err));
    return { error: "ai_models_failed", detail: e.message, status: 422 };
  }
}

// ── POST /api/admin/ai/test ──────────────────────────────────────────────────────────────────

async function testAndRecord(input: ResolvedInput, model: string, userId: string): Promise<AiTestResult> {
  const result = await runAiTest({ provider: input.provider, baseUrl: input.baseUrl, token: input.token, model }, { fetchImpl });
  // Every test costs tokens → one ai_usage row under the reserved `test` feature (§40.5).
  await recordAiUsage(pool, {
    feature: AI_TEST_FEATURE,
    userId,
    provider: input.provider,
    model: result.model ?? model,
    inputTokens: null,
    outputTokens: null,
    latencyMs: result.latencyMs,
    ok: result.ok,
    errorCode: result.errorCode,
  });
  return result;
}

/** The saved config, tested unchanged (same provider / URL / model, stored token)? */
function isSavedConfig(input: ResolvedInput, model: string): boolean {
  return Boolean(input.row && !input.tokenFromForm && input.row.provider === input.provider && input.row.baseUrl === input.baseUrl && input.row.model === model);
}

async function writeLastTest(r: AiTestResult): Promise<void> {
  await pool.query(
    `update ai_integration set last_test_at = now(), last_test_ok = $1, last_test_error = $2, last_test_latency_ms = $3 where id = 1`,
    [r.ok, r.ok ? null : `${r.errorCode}: ${r.error}`, r.latencyMs],
  );
}

export async function testFromForm(body: Record<string, unknown>, userId: string): Promise<AiTestResult | AiApiError> {
  const key = keyOrError();
  if (isAiApiError(key)) return key;
  const input = await resolveInput(body, key);
  if (isAiApiError(input)) return input;
  const model = validateAiModel(body.model);
  if (!model) return { error: "invalid_model", detail: "choose or enter a model", status: 422 };
  const result = await testAndRecord(input, model, userId);
  if (isSavedConfig(input, model)) await writeLastTest(result);
  return result;
}

// ── PUT /api/admin/ai (save — runs the test first) ───────────────────────────────────────────

export type SaveResult = { ok: true; unchanged: boolean; test: AiTestResult | null } | (AiApiError & { test?: AiTestResult });

export async function saveFromForm(body: Record<string, unknown>, userId: string): Promise<SaveResult> {
  const key = keyOrError();
  if (isAiApiError(key)) return key;
  const input = await resolveInput(body, key);
  if (isAiApiError(input)) return input;
  const model = validateAiModel(body.model);
  if (!model) return { error: "invalid_model", detail: "choose or enter a model", status: 422 };

  const row = input.row;
  const storedToken = row ? decryptAiToken(row, key) : null;
  const tokenRotated = input.tokenFromForm && input.token !== storedToken;
  // Identical values → nothing to do: no test, no audit (§40.6).
  if (row && row.provider === input.provider && row.baseUrl === input.baseUrl && row.model === model && !tokenRotated) {
    return { ok: true, unchanged: true, test: null };
  }

  const test = await testAndRecord(input, model, userId);
  if (!test.ok) return { error: "ai_test_failed", detail: test.error ?? "the test failed", status: 422, test };

  const tokenEnc = tokenRotated ? encryptAiToken(input.token, key) : row!.tokenEnc;
  const last4 = tokenRotated ? tokenLast4(input.token) : row!.tokenLast4;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into ai_integration (id, enabled, provider, base_url, model, token_enc, token_last4,
                                   last_test_at, last_test_ok, last_test_error, last_test_latency_ms,
                                   updated_by_user_id, updated_at)
       values (1, false, $1, $2, $3, $4, $5, now(), true, null, $6, $7, now())
       on conflict (id) do update set
         provider = excluded.provider, base_url = excluded.base_url, model = excluded.model,
         token_enc = excluded.token_enc, token_last4 = excluded.token_last4,
         last_test_at = excluded.last_test_at, last_test_ok = true, last_test_error = null,
         last_test_latency_ms = excluded.last_test_latency_ms,
         updated_by_user_id = excluded.updated_by_user_id, updated_at = now()`,
      [input.provider, input.baseUrl, model, tokenEnc, last4, test.latencyMs, userId],
    );
    await appendAudit(client, {
      actorUserId: userId,
      action: "ai.config_updated",
      targetType: "ai_integration",
      before: row ? { provider: row.provider, baseUrl: row.baseUrl, model: row.model } : null,
      // Never the token or any part of it — only whether it changed (§40.11).
      after: { provider: input.provider, baseUrl: input.baseUrl, model, token_rotated: tokenRotated },
    });
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { ok: true, unchanged: false, test };
}

// ── PATCH /api/admin/ai (enable / disable) ───────────────────────────────────────────────────

export async function setAiEnabled(enabled: boolean, userId: string): Promise<{ ok: true; enabled: boolean } | AiApiError> {
  const key = keyOrError();
  if (isAiApiError(key)) return key;
  const row = await loadAiConfig(pool);
  if (!row) return { error: "ai_not_configured", detail: "save a configuration first", status: 409 };
  if (row.enabled === enabled) return { ok: true, enabled };
  if (enabled) {
    if (decryptAiToken(row, key) === null) return { error: "ai_token_undecryptable", detail: "the stored token can't be decrypted — replace it", status: 409 };
    if (row.lastTestOk !== true) return { error: "ai_test_required", detail: "the saved configuration must pass a test before it can be enabled", status: 409 };
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`update ai_integration set enabled = $1, updated_by_user_id = $2, updated_at = now() where id = 1`, [enabled, userId]);
    await appendAudit(client, {
      actorUserId: userId,
      action: enabled ? "ai.enabled" : "ai.disabled",
      targetType: "ai_integration",
      after: { provider: row.provider, baseUrl: row.baseUrl, model: row.model },
    });
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { ok: true, enabled };
}

// ── DELETE /api/admin/ai (remove integration) ────────────────────────────────────────────────

export async function removeAiIntegration(userId: string): Promise<{ ok: true } | AiApiError> {
  const key = keyOrError();
  if (isAiApiError(key)) return key;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ provider: string; base_url: string; model: string; enabled: boolean }>(
      `delete from ai_integration where id = 1 returning provider, base_url, model, enabled`,
    );
    const gone = rows[0];
    if (!gone) {
      await client.query("rollback");
      return { error: "ai_not_configured", detail: "nothing to remove", status: 404 };
    }
    await appendAudit(client, {
      actorUserId: userId,
      action: "ai.config_cleared",
      targetType: "ai_integration",
      before: { provider: gone.provider, baseUrl: gone.base_url, model: gone.model, enabled: gone.enabled },
    });
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { ok: true };
}

/** §46.2 the pre-review row's state. `aiOn` = the integration is operational right now. */
async function prereviewAdminState(aiOn: boolean): Promise<AiAdminStatus["prereview"]> {
  const [setting, counts] = await Promise.all([loadPrereviewSetting(pool), prereviewCounts(pool)]);
  return { enabled: setting.enabled, effective: setting.enabled && aiOn, pending: counts.pending, failed24h: counts.failed24h };
}
