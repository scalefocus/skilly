// Unit tests for the §40 AI integration helper: base-URL normalization, both providers' wire
// formats, JSON mode, the retry policy, redirects, status derivation, the feature registry gate,
// usage/System-log bookkeeping (against a fake DB) and token crypto. SKILLY_SPEC.md §40.13.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_BUDGET_EXHAUSTED_MESSAGE,
  AI_FEATURES,
  AI_FEATURE_MAX_TOKENS_CEILING,
  AI_FEATURE_TIMEOUT_CEILING_MS,
  aiFeatureMaxTokens,
  aiFeatureTimeoutMs,
  AI_TEST_MAX_TOKENS,
  AiError,
  aiAvailable,
  aiComplete,
  buildCompletionRequest,
  buildModelsRequest,
  decryptAiToken,
  deriveAiStatus,
  encryptAiToken,
  isRetryable,
  listAiModels,
  normalizeAiBaseUrl,
  parseAiJson,
  parseAiTokenKey,
  parseCompletionResponse,
  parseModelsResponse,
  providerErrorText,
  retryDelayMs,
  runAiTest,
  sanitizeAiError,
  stripCodeFence,
  tokenLast4,
  validateAiModel,
  type AiDb,
  type AiEnv,
  type AiFeature,
} from "./ai.js";

const KEY = parseAiTokenKey(Buffer.alloc(32, 9).toString("base64"))!;
const OTHER_KEY = parseAiTokenKey(Buffer.alloc(32, 3).toString("base64"))!;
const FEATURES: AiFeature[] = [{ key: "summarize", label: "Summaries", egress: "skill text", spec: "§99" }];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A fetch fake that answers from a queue and records each call. */
function fakeFetch(answers: Array<Response | Error | ((url: string, init: RequestInit) => Response | Promise<Response>)>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const a = answers.shift();
    if (!a) throw new Error("unexpected fetch");
    if (a instanceof Error) throw a;
    if (typeof a === "function") return a(url, init);
    return a;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// ── validation ───────────────────────────────────────────────────────────────────────────────

test("normalizeAiBaseUrl: defaults, required, scheme, credentials, query/fragment, trailing slash", () => {
  assert.deepEqual(normalizeAiBaseUrl("anthropic", ""), { ok: true, url: "https://api.anthropic.com" });
  assert.equal(normalizeAiBaseUrl("openwebui", "  ").ok, false);
  assert.deepEqual(normalizeAiBaseUrl("openwebui", "http://owui.corp.local:8080/"), { ok: true, url: "http://owui.corp.local:8080" });
  assert.deepEqual(normalizeAiBaseUrl("openwebui", "https://h.example/prefix//"), { ok: true, url: "https://h.example/prefix" });
  assert.equal(normalizeAiBaseUrl("anthropic", "ftp://x").ok, false);
  assert.equal(normalizeAiBaseUrl("anthropic", "https://u:p@x.example").ok, false);
  assert.equal(normalizeAiBaseUrl("anthropic", "https://x.example/?a=1").ok, false);
  assert.equal(normalizeAiBaseUrl("anthropic", "https://x.example/#f").ok, false);
  assert.equal(normalizeAiBaseUrl("anthropic", "not a url").ok, false);
  assert.equal(normalizeAiBaseUrl("anthropic", "https://x.example/" + "a".repeat(600)).ok, false);
});

test("normalizeAiBaseUrl: Open WebUI drops one trailing /api segment (§40.2); Anthropic does not", () => {
  assert.deepEqual(normalizeAiBaseUrl("openwebui", "https://ai.example.com/api"), { ok: true, url: "https://ai.example.com" });
  assert.deepEqual(normalizeAiBaseUrl("openwebui", "https://ai.example.com/api/"), { ok: true, url: "https://ai.example.com" });
  assert.deepEqual(normalizeAiBaseUrl("openwebui", "https://ai.example.com/API"), { ok: true, url: "https://ai.example.com" });
  assert.deepEqual(normalizeAiBaseUrl("openwebui", "https://h.example/openwebui/api"), { ok: true, url: "https://h.example/openwebui" });
  assert.deepEqual(normalizeAiBaseUrl("openwebui", "https://h.example/openwebui"), { ok: true, url: "https://h.example/openwebui" });
  assert.deepEqual(normalizeAiBaseUrl("openwebui", "https://h.example/rapid"), { ok: true, url: "https://h.example/rapid" });
  assert.deepEqual(normalizeAiBaseUrl("anthropic", "https://gw.example/api"), { ok: true, url: "https://gw.example/api" });
});

test("validateAiModel / tokenLast4 / sanitizeAiError", () => {
  assert.equal(validateAiModel(" claude-sonnet-5-5 "), "claude-sonnet-5-5");
  assert.equal(validateAiModel(""), null);
  assert.equal(validateAiModel("a\nb"), null);
  assert.equal(validateAiModel("x".repeat(201)), null);
  assert.equal(validateAiModel(42), null);
  assert.equal(tokenLast4("sk-ant-123456abcd"), "abcd");
  assert.equal(tokenLast4("abc"), "");
  assert.equal(sanitizeAiError("bad key sk-SECRET-1 in\nline two", "sk-SECRET-1"), "bad key *** in line two");
  assert.equal(sanitizeAiError("x".repeat(400)).length, 300);
});

// ── wire format ──────────────────────────────────────────────────────────────────────────────

test("buildCompletionRequest: Anthropic Messages shape + x-api-key", () => {
  const r = buildCompletionRequest(
    { provider: "anthropic", baseUrl: "https://api.anthropic.com", token: "tok" },
    { model: "m", system: "sys", messages: [{ role: "user", content: "hi" }], maxTokens: 10 },
  );
  assert.equal(r.url, "https://api.anthropic.com/v1/messages");
  assert.equal(r.path, "/v1/messages");
  assert.equal(r.init.headers["x-api-key"], "tok");
  assert.equal(r.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(r.init.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(r.init.body!), { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }], system: "sys" });
});

test("buildCompletionRequest: Open WebUI chat-completions shape + bearer, system as first message", () => {
  const r = buildCompletionRequest(
    { provider: "openwebui", baseUrl: "https://owui.local/p", token: "tok" },
    { model: "llama3", system: "sys", messages: [{ role: "user", content: "hi" }], maxTokens: 5 },
  );
  assert.equal(r.url, "https://owui.local/p/api/chat/completions");
  assert.equal(r.init.headers.authorization, "Bearer tok");
  assert.equal(r.init.headers["x-api-key"], undefined);
  const body = JSON.parse(r.init.body!);
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 5);
  assert.deepEqual(body.messages[0], { role: "system", content: "sys" });
});

test("parseCompletionResponse: text + usage for both providers; bad shapes throw", () => {
  const a = parseCompletionResponse("anthropic", {
    model: "claude-x",
    content: [{ type: "text", text: "Hel" }, { type: "tool_use" }, { type: "text", text: "lo" }],
    usage: { input_tokens: 12, output_tokens: 3 },
  });
  assert.deepEqual(a, { text: "Hello", model: "claude-x", inputTokens: 12, outputTokens: 3 });
  const o = parseCompletionResponse("openwebui", { model: "llama3", choices: [{ message: { content: "OK" } }] });
  assert.deepEqual(o, { text: "OK", model: "llama3", inputTokens: null, outputTokens: null });
  const ou = parseCompletionResponse("openwebui", { choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 4, completion_tokens: 1 } });
  assert.equal(ou.inputTokens, 4);
  assert.throws(() => parseCompletionResponse("anthropic", {}), (e: unknown) => e instanceof AiError && e.code === "ai_provider_error");
  assert.throws(() => parseCompletionResponse("openwebui", { choices: [] }), AiError);
});

test("parseCompletionResponse: a reasoning model that ran out of budget gets its own message (§40.2)", () => {
  const exhausted = { choices: [{ finish_reason: "length", message: { role: "assistant", reasoning_content: "The user wants", content: null } }] };
  assert.throws(
    () => parseCompletionResponse("openwebui", exhausted),
    (e: unknown) => e instanceof AiError && e.code === "ai_provider_error" && e.message === AI_BUDGET_EXHAUSTED_MESSAGE,
  );
  // Content missing for any other reason keeps the generic shape error.
  assert.throws(
    () => parseCompletionResponse("openwebui", { choices: [{ finish_reason: "stop", message: { content: null } }] }),
    (e: unknown) => e instanceof AiError && /no choices/.test(e.message),
  );
});

test("models list: endpoints per provider; parse sorts, de-dupes, rejects bad shape", () => {
  assert.equal(buildModelsRequest({ provider: "anthropic", baseUrl: "https://a", token: "t" }).url, "https://a/v1/models?limit=1000");
  assert.equal(buildModelsRequest({ provider: "openwebui", baseUrl: "https://o", token: "t" }).url, "https://o/api/models");
  assert.deepEqual(parseModelsResponse({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, { name: "x" }] }), ["a", "b"]);
  assert.throws(() => parseModelsResponse({ models: [] }), AiError);
});

test("providerErrorText: Anthropic / OpenAI / FastAPI detail / raw fallbacks", () => {
  assert.equal(providerErrorText({ error: { message: "invalid x-api-key" } }, ""), "invalid x-api-key");
  assert.equal(providerErrorText({ detail: "Not authenticated" }, ""), "Not authenticated");
  assert.equal(providerErrorText(null, "  Bad Gateway "), "Bad Gateway");
});

// ── JSON mode ────────────────────────────────────────────────────────────────────────────────

test("parseAiJson: plain, fenced, and invalid", () => {
  assert.deepEqual(parseAiJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseAiJson('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
  assert.deepEqual(parseAiJson("```\n[true]\n```"), [true]);
  assert.throws(() => parseAiJson("Sure! here you go"), (e: unknown) => e instanceof AiError && e.code === "ai_invalid_json");
  assert.deepEqual(parseAiJson('```{"one":"line"}```'), { one: "line" });
  assert.deepEqual(parseAiJson('```json  \r\n{"crlf":true}\r\n```'), { crlf: true });
});

test("stripCodeFence: linear on adversarial input (CodeQL js/polynomial-redos)", () => {
  const evil = "```" + " ".repeat(200_000) + "\n".repeat(50_000) + "x";
  const t0 = Date.now();
  assert.throws(() => parseAiJson(evil), (e: unknown) => (e as AiError).code === "ai_invalid_json");
  assert.throws(() => parseAiJson(evil + "```"), (e: unknown) => (e as AiError).code === "ai_invalid_json");
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
  assert.equal(stripCodeFence("no fence"), "no fence");
  assert.equal(stripCodeFence("``````"), "");
});

// ── retry policy ─────────────────────────────────────────────────────────────────────────────

test("isRetryable: network, 429 and 5xx only", () => {
  assert.equal(isRetryable(new AiError("ai_provider_error", "net")), true);
  assert.equal(isRetryable(new AiError("ai_provider_error", "x", { httpStatus: 429 })), true);
  assert.equal(isRetryable(new AiError("ai_provider_error", "x", { httpStatus: 503 })), true);
  assert.equal(isRetryable(new AiError("ai_provider_error", "x", { httpStatus: 401 })), false);
  assert.equal(isRetryable(new AiError("ai_timeout", "x")), false);
  assert.equal(isRetryable(new Error("x")), false);
});

test("retryDelayMs: seconds, HTTP date, cap at 10 s, default 1 s", () => {
  assert.equal(retryDelayMs("2"), 2000);
  assert.equal(retryDelayMs("120"), 10_000);
  assert.equal(retryDelayMs(null), 1000);
  assert.equal(retryDelayMs("garbage"), 1000);
  const now = Date.parse("2026-10-06T00:00:00Z");
  assert.equal(retryDelayMs(new Date(now + 3000).toUTCString(), now), 3000);
});

// ── test + model list (no DB) ────────────────────────────────────────────────────────────────

test("runAiTest: pass reports latency + echoed model", async () => {
  const f = fakeFetch([json({ model: "claude-echo", content: [{ type: "text", text: "OK" }] })]);
  const r = await runAiTest({ provider: "anthropic", baseUrl: "https://a", token: "tok", model: "claude-x" }, { fetchImpl: f.impl });
  assert.equal(r.ok, true);
  assert.equal(r.model, "claude-echo");
  assert.equal(r.error, null);
  assert.equal(AI_TEST_MAX_TOKENS, 1024);
  assert.equal(JSON.parse(f.calls[0]!.init.body as string).max_tokens, 1024);
  assert.equal(f.calls[0]!.init.redirect, "manual");
});

test("runAiTest: a reply cut off by the budget fails with the budget-exhausted message", async () => {
  const f = fakeFetch([json({ model: "scale-gpt-3", choices: [{ finish_reason: "length", message: { content: null, reasoning_content: "thinking" } }] })]);
  const r = await runAiTest({ provider: "openwebui", baseUrl: "https://owui", token: "tok", model: "scale-gpt" }, { fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.equal(r.error, AI_BUDGET_EXHAUSTED_MESSAGE);
  assert.equal(r.errorCode, "ai_provider_error");
});

test("runAiTest: provider error is sanitized and token-redacted, no retry", async () => {
  const f = fakeFetch([json({ error: { message: "invalid key tok-SECRET" } }, 401)]);
  const r = await runAiTest({ provider: "anthropic", baseUrl: "https://a", token: "tok-SECRET", model: "m" }, { fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.equal(r.httpStatus, 401);
  assert.equal(r.errorCode, "ai_provider_error");
  assert.ok(!r.error!.includes("tok-SECRET"));
  assert.equal(f.calls.length, 1);
});

test("runAiTest: a redirect is an error and is not followed", async () => {
  const f = fakeFetch([new Response(null, { status: 302, headers: { location: "https://evil.example" } })]);
  const r = await runAiTest({ provider: "openwebui", baseUrl: "https://o", token: "t", model: "m" }, { fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.match(r.error!, /redirect/);
  assert.equal(f.calls.length, 1);
});

test("runAiTest: timeout → ai_timeout", async () => {
  const hang = ((_u: string, init: RequestInit) =>
    new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
  const r = await runAiTest({ provider: "openwebui", baseUrl: "https://o", token: "t", model: "m" }, { fetchImpl: hang, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, "ai_timeout");
});

test("providerFetch: response over 1 MB is refused", async () => {
  const big = new Response("x".repeat(1024 * 1024 + 10), { status: 200 });
  const f = fakeFetch([big]);
  const r = await runAiTest({ provider: "openwebui", baseUrl: "https://o", token: "t", model: "m" }, { fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.match(r.error!, /1 MB/);
});

test("listAiModels: returns ids; failure throws AiError", async () => {
  const ok = fakeFetch([json({ data: [{ id: "llama3" }, { id: "gemma" }] })]);
  assert.deepEqual(await listAiModels({ provider: "openwebui", baseUrl: "https://o", token: "t" }, { fetchImpl: ok.impl }), ["gemma", "llama3"]);
  const bad = fakeFetch([json({ detail: "nope" }, 403)]);
  await assert.rejects(listAiModels({ provider: "openwebui", baseUrl: "https://o", token: "t" }, { fetchImpl: bad.impl }), AiError);
});

// ── status ───────────────────────────────────────────────────────────────────────────────────

test("deriveAiStatus: four states, more recent signal wins", () => {
  const base = { enabled: true, lastTestAt: "2026-10-01T10:00:00Z", lastTestOk: true, lastTestError: null, lastCallAt: null, lastCallOk: null, lastCallError: null };
  assert.equal(deriveAiStatus(null, true).status, "not_configured");
  assert.equal(deriveAiStatus({ ...base, enabled: false }, true).status, "off");
  assert.equal(deriveAiStatus(base, false).status, "failing");
  assert.match(deriveAiStatus(base, false).reason!, /decrypt/);
  assert.equal(deriveAiStatus(base, true).status, "operational");
  const callFailedLater = { ...base, lastCallAt: "2026-10-01T11:00:00Z", lastCallOk: false, lastCallError: "ai_timeout: slow" };
  assert.deepEqual(deriveAiStatus(callFailedLater, true), { status: "failing", reason: "ai_timeout: slow", at: "2026-10-01T11:00:00Z" });
  const testPassedAfter = { ...callFailedLater, lastTestAt: "2026-10-01T12:00:00Z" };
  assert.equal(deriveAiStatus(testPassedAfter, true).status, "operational");
  const testFailedLatest = { ...base, lastTestOk: false, lastTestError: "HTTP 401", lastCallAt: "2026-10-01T09:00:00Z", lastCallOk: true };
  assert.equal(deriveAiStatus(testFailedLatest, true).status, "failing");
});

// ── crypto ───────────────────────────────────────────────────────────────────────────────────

test("token crypto: round-trip; wrong / missing key → null", () => {
  const enc = encryptAiToken("sk-secret", KEY);
  assert.ok(!enc.includes("sk-secret"));
  assert.equal(decryptAiToken({ tokenEnc: enc }, KEY), "sk-secret");
  assert.equal(decryptAiToken({ tokenEnc: enc }, OTHER_KEY), null);
  assert.equal(decryptAiToken({ tokenEnc: enc }, null), null);
  assert.equal(parseAiTokenKey("short"), null);
});

// ── aiComplete against a fake DB ─────────────────────────────────────────────────────────────

interface FakeState {
  row: Record<string, unknown> | null;
  usage: unknown[][];
  events: unknown[][];
  claimOpen: boolean;
}

function fakeDb(state: FakeState): AiDb {
  return {
    async query(text: string, params: unknown[] = []) {
      const sql = text.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql.startsWith("select enabled, provider")) return { rows: state.row ? [state.row] : [], rowCount: state.row ? 1 : 0 };
      if (sql.startsWith("insert into ai_usage")) {
        state.usage.push(params);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("update ai_integration set last_call_at")) {
        if (state.row) Object.assign(state.row, { last_call_at: new Date(), last_call_ok: params[0], last_call_error: params[1] });
        return { rows: [], rowCount: state.row ? 1 : 0 };
      }
      if (sql.startsWith("update ai_integration set last_failure_logged_at")) {
        const ok = state.claimOpen;
        state.claimOpen = false;
        return { rows: [], rowCount: ok ? 1 : 0 };
      }
      if (sql.startsWith("insert into system_event")) {
        state.events.push(params);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

function stateWith(over: Record<string, unknown> = {}, token = "sk-live-token"): FakeState {
  return {
    row: {
      enabled: true,
      provider: "anthropic",
      base_url: "https://api.anthropic.com",
      model: "claude-x",
      token_enc: encryptAiToken(token, KEY),
      token_last4: "oken",
      last_test_at: new Date(),
      last_test_ok: true,
      last_test_error: null,
      last_test_latency_ms: 10,
      last_call_at: null,
      last_call_ok: null,
      last_call_error: null,
      updated_by_user_id: null,
      updated_at: new Date(),
      ...over,
    },
    usage: [],
    events: [],
    claimOpen: true,
  };
}

function env(fetchImpl: typeof fetch, over: Partial<AiEnv> = {}): AiEnv {
  return { key: KEY, source: "web", features: FEATURES, fetchImpl, sleep: async () => {}, ...over };
}

const MSG = [{ role: "user" as const, content: "hello" }];

test("aiComplete: success records one usage row and a passing last call", async () => {
  const st = stateWith();
  const f = fakeFetch([json({ model: "claude-x", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 5, output_tokens: 2 } })]);
  const r = await aiComplete(fakeDb(st), env(f.impl), { feature: "summarize", userId: "u1", messages: MSG, maxTokens: 50 });
  assert.equal(r.text, "hi");
  assert.equal(r.inputTokens, 5);
  assert.equal(st.usage.length, 1);
  assert.deepEqual(st.usage[0]!.slice(0, 4), ["summarize", "u1", "anthropic", "claude-x"]);
  assert.equal(st.usage[0]![7], true);
  assert.equal(st.row!.last_call_ok, true);
  assert.equal(st.events.length, 0);
  assert.equal((f.calls[0]!.init.headers as Record<string, string>)["x-api-key"], "sk-live-token");
  assert.equal(f.calls[0]!.url, "https://api.anthropic.com/v1/messages");
});

test("aiComplete: unknown / reserved feature throws before any DB read or fetch", async () => {
  const st = stateWith();
  const f = fakeFetch([]);
  for (const feature of ["nope", "test"]) {
    await assert.rejects(
      aiComplete(fakeDb(st), env(f.impl), { feature, messages: MSG, maxTokens: 5 }),
      (e: unknown) => e instanceof AiError && e.code === "ai_unknown_feature",
    );
  }
  assert.equal(f.calls.length, 0);
  assert.equal(st.usage.length, 0);
});

test("aiComplete: not configured / disabled / key missing write nothing", async () => {
  const f = fakeFetch([]);
  const none: FakeState = { row: null, usage: [], events: [], claimOpen: true };
  await assert.rejects(aiComplete(fakeDb(none), env(f.impl), { feature: "summarize", messages: MSG, maxTokens: 5 }), (e: unknown) => (e as AiError).code === "ai_not_configured");
  const off = stateWith({ enabled: false });
  await assert.rejects(aiComplete(fakeDb(off), env(f.impl), { feature: "summarize", messages: MSG, maxTokens: 5 }), (e: unknown) => (e as AiError).code === "ai_disabled");
  const nokey = stateWith();
  await assert.rejects(aiComplete(fakeDb(nokey), env(f.impl, { key: null }), { feature: "summarize", messages: MSG, maxTokens: 5 }), (e: unknown) => (e as AiError).code === "ai_key_missing");
  for (const s of [off, nokey]) {
    assert.equal(s.usage.length, 0);
    assert.equal(s.row!.last_call_at, null);
    assert.equal(s.events.length, 0);
  }
  assert.equal(f.calls.length, 0);
});

test("aiComplete: undecryptable token → failing last call + system event, no usage row", async () => {
  const st = stateWith();
  const f = fakeFetch([]);
  await assert.rejects(
    aiComplete(fakeDb(st), env(f.impl, { key: OTHER_KEY }), { feature: "summarize", messages: MSG, maxTokens: 5 }),
    (e: unknown) => (e as AiError).code === "ai_token_undecryptable",
  );
  assert.equal(st.usage.length, 0);
  assert.equal(st.row!.last_call_ok, false);
  assert.equal(st.events.length, 1);
  assert.equal(st.events[0]![0], 500);
  assert.equal(f.calls.length, 0);
});

test("aiComplete: 503 then success = one retry, ONE usage row (ok)", async () => {
  const st = stateWith();
  const f = fakeFetch([json({ error: { message: "overloaded" } }, 503), json({ content: [{ type: "text", text: "ok" }] })]);
  const r = await aiComplete(fakeDb(st), env(f.impl), { feature: "summarize", messages: MSG, maxTokens: 5 });
  assert.equal(r.text, "ok");
  assert.equal(f.calls.length, 2);
  assert.equal(st.usage.length, 1);
  assert.equal(st.usage[0]![7], true);
});

test("aiComplete: retry:false makes exactly one attempt on a 503 (§43.9)", async () => {
  const st = stateWith();
  const f = fakeFetch([json({ error: { message: "overloaded" } }, 503), json({ content: [{ type: "text", text: "ok" }] })]);
  await assert.rejects(
    aiComplete(fakeDb(st), env(f.impl), { feature: "summarize", messages: MSG, maxTokens: 5, retry: false }),
    (e: unknown) => e instanceof AiError && e.code === "ai_provider_error" && e.httpStatus === 503,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(st.usage.length, 1);
  assert.equal(st.usage[0]![7], false);
});

test("AI_FEATURES registers skill_draft with its §43 egress", () => {
  const draft = AI_FEATURES.find((f) => f.key === "skill_draft");
  assert.ok(draft);
  assert.equal(draft.spec, "§43");
  assert.match(draft.egress, /SKILL\.md/);
  assert.match(draft.egress, /category names/);
});

test("aiComplete: 401 is not retried; failure → usage(error) + last call + throttled 502 system event", async () => {
  const st = stateWith();
  const f = fakeFetch([json({ error: { message: "invalid x-api-key sk-live-token" } }, 401)]);
  await assert.rejects(
    aiComplete(fakeDb(st), env(f.impl, { source: "worker" }), { feature: "summarize", userId: "u9", messages: MSG, maxTokens: 5 }),
    (e: unknown) => e instanceof AiError && e.code === "ai_provider_error" && e.httpStatus === 401 && !e.message.includes("sk-live-token"),
  );
  assert.equal(f.calls.length, 1);
  assert.equal(st.usage.length, 1);
  assert.equal(st.usage[0]![7], false);
  assert.equal(st.usage[0]![8], "ai_provider_error");
  assert.equal(st.row!.last_call_ok, false);
  assert.equal(st.events.length, 1);
  const [status, route, path, userId, code, message, , source] = st.events[0]!;
  assert.deepEqual([status, route, path, userId, code, source], [502, "ai:summarize", "/v1/messages", "u9", "ai_provider_error", "worker"]);
  assert.ok(!String(message).includes("sk-live-token"));

  // A second failure inside the 15-minute window claims nothing → no second event.
  const f2 = fakeFetch([json({}, 400)]);
  await assert.rejects(aiComplete(fakeDb(st), env(f2.impl), { feature: "summarize", messages: MSG, maxTokens: 5 }));
  assert.equal(st.events.length, 1);
  assert.equal(st.usage.length, 2);
});

test("aiComplete: two failing attempts (network) → one usage row", async () => {
  const st = stateWith();
  const f = fakeFetch([new Error("ECONNREFUSED"), new Error("ECONNREFUSED")]);
  await assert.rejects(aiComplete(fakeDb(st), env(f.impl), { feature: "summarize", messages: MSG, maxTokens: 5 }));
  assert.equal(f.calls.length, 2);
  assert.equal(st.usage.length, 1);
});

test("aiComplete: json mode parses fenced JSON and appends the JSON instruction", async () => {
  const st = stateWith({ provider: "openwebui", base_url: "https://owui.local" });
  const f = fakeFetch([json({ choices: [{ message: { content: '```json\n{"tags":["a"]}\n```' } }] })]);
  const r = await aiComplete(fakeDb(st), env(f.impl), { feature: "summarize", system: "Tag it.", messages: MSG, maxTokens: 50, json: true });
  assert.deepEqual(r.json, { tags: ["a"] });
  const sent = JSON.parse(f.calls[0]!.init.body as string);
  assert.match(sent.messages[0].content, /^Tag it\.\n\nRespond with a single JSON value only/);
  assert.equal((f.calls[0]!.init.headers as Record<string, string>).authorization, "Bearer sk-live-token");
});

test("aiComplete: json mode invalid JSON → ai_invalid_json, recorded, not retried", async () => {
  const st = stateWith();
  const f = fakeFetch([json({ content: [{ type: "text", text: "not json" }] })]);
  await assert.rejects(
    aiComplete(fakeDb(st), env(f.impl), { feature: "summarize", messages: MSG, maxTokens: 5, json: true }),
    (e: unknown) => (e as AiError).code === "ai_invalid_json",
  );
  assert.equal(f.calls.length, 1);
  assert.equal(st.usage[0]![8], "ai_invalid_json");
  assert.equal(st.events[0]![0], 502);
});

test("aiComplete: argument validation", async () => {
  const st = stateWith();
  const f = fakeFetch([]);
  await assert.rejects(aiComplete(fakeDb(st), env(f.impl), { feature: "summarize", messages: [], maxTokens: 5 }), /messages/);
  await assert.rejects(aiComplete(fakeDb(st), env(f.impl), { feature: "summarize", messages: MSG, maxTokens: 0 }), /maxTokens/);
  await assert.rejects(aiComplete(fakeDb(st), env(f.impl), { feature: "summarize", messages: MSG, maxTokens: 9000 }), /maxTokens/);
});

test("aiAvailable: configured + enabled + decryptable", async () => {
  assert.equal(await aiAvailable(fakeDb(stateWith()), { key: KEY }), true);
  assert.equal(await aiAvailable(fakeDb(stateWith({ enabled: false })), { key: KEY }), false);
  assert.equal(await aiAvailable(fakeDb(stateWith()), { key: OTHER_KEY }), false);
  assert.equal(await aiAvailable(fakeDb({ row: null, usage: [], events: [], claimOpen: true }), { key: KEY }), false);
});

// ── §40.7 per-feature ceilings & cancellation (§44) ─────────────────────────────────────────────

test("aiFeatureMaxTokens / aiFeatureTimeoutMs: defaults, declared values, and the clamps", () => {
  assert.equal(aiFeatureMaxTokens({}), 8192);
  assert.equal(aiFeatureMaxTokens({ maxTokens: 20000 }), 20000);
  assert.equal(aiFeatureMaxTokens({ maxTokens: 99999 }), AI_FEATURE_MAX_TOKENS_CEILING);
  assert.equal(aiFeatureTimeoutMs({}), 60_000);
  assert.equal(aiFeatureTimeoutMs({ timeoutMs: 120_000 }), 120_000);
  assert.equal(aiFeatureTimeoutMs({ timeoutMs: 9_999_999 }), AI_FEATURE_TIMEOUT_CEILING_MS);
});

test("AI_FEATURES registers skill_quality_draft (§44.4) with the 32,768-token / 360 s ceilings", () => {
  const f = AI_FEATURES.find((x) => x.key === "skill_quality_draft");
  assert.ok(f);
  assert.equal(f!.spec, "§44");
  assert.equal(f!.maxTokens, 32_768);
  assert.equal(f!.timeoutMs, 360_000);
  assert.match(f!.egress, /never sent/);
  // The quality assessment keeps the default ceiling.
  assert.equal(AI_FEATURES.find((x) => x.key === "skill_quality")!.maxTokens, undefined);
});

test("aiComplete: maxTokens above 8192 is allowed only for a feature that declares a higher ceiling", async () => {
  const big: AiFeature[] = [...FEATURES, { key: "big", label: "Big", egress: "x", spec: "§99", maxTokens: 32_768 }];
  const st = stateWith();
  const f = fakeFetch([json({ model: "claude-x", content: [{ type: "text", text: "ok" }] })]);
  await assert.rejects(aiComplete(fakeDb(st), env(f.impl, { features: big }), { feature: "summarize", messages: MSG, maxTokens: 9000 }), /maxTokens must be an integer 1–8192/);
  const r = await aiComplete(fakeDb(st), env(f.impl, { features: big }), { feature: "big", messages: MSG, maxTokens: 32_768 });
  assert.equal(r.text, "ok");
  assert.equal(JSON.parse(String(f.calls[0]!.init.body)).max_tokens, 32_768);
  await assert.rejects(aiComplete(fakeDb(st), env(f.impl, { features: big }), { feature: "big", messages: MSG, maxTokens: 32_769 }), /1–32768/);
});

test("aiComplete: an aborted signal ends the call as ai_cancelled — recorded, never retried, never System-logged", async () => {
  const st = stateWith();
  const ctrl = new AbortController();
  const f = fakeFetch([
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        ctrl.abort();
      }),
  ]);
  await assert.rejects(
    aiComplete(fakeDb(st), env(f.impl), { feature: "summarize", messages: MSG, maxTokens: 5, signal: ctrl.signal }),
    (e: unknown) => e instanceof AiError && e.code === "ai_cancelled",
  );
  assert.equal(f.calls.length, 1);
  assert.equal(st.usage.length, 1);
  assert.equal(st.usage[0]![8], "ai_cancelled");
  assert.equal(st.events.length, 0);
});

// ── §40.15 admin timeout overrides ──────────────────────────────────────────────────────────────

/** Runs one call against a provider that never answers and reports whether it was aborted at each tick. */
async function abortedAt(row: Record<string, unknown>, ticks: number[]): Promise<boolean[]> {
  const st = stateWith(row);
  let signal: AbortSignal | null = null;
  const f = fakeFetch([
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init.signal ?? null;
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  ]);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const call = aiComplete(fakeDb(st), env(f.impl), { feature: "summarize", messages: MSG, maxTokens: 5 }).catch((e: unknown) => e);
    while (f.calls.length === 0) await new Promise((r) => setImmediate(r));
    const seen: boolean[] = [];
    for (const t of ticks) {
      mock.timers.tick(t);
      seen.push(Boolean((signal as AbortSignal | null)?.aborted));
    }
    mock.timers.tick(AI_FEATURE_TIMEOUT_CEILING_MS);
    const err = await call;
    assert.ok(err instanceof AiError && err.code === "ai_timeout", String(err));
    return seen;
  } finally {
    mock.timers.reset();
  }
}

test("aiComplete: the stored admin override (§40.15) sets the attempt timeout", async () => {
  assert.deepEqual(await abortedAt({ ai_timeouts: { calls: { summarize: 15_000 } } }, [14_999, 1]), [false, true]);
});

test("aiComplete: without an override for this feature the registered default (60 s) applies", async () => {
  assert.deepEqual(await abortedAt({ ai_timeouts: { calls: { other_feature: 15_000 } } }, [15_000, 44_999, 1]), [false, false, true]);
  assert.deepEqual(await abortedAt({}, [59_999, 1]), [false, true]);
});
