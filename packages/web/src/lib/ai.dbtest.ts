// Live-DB integration test for the §40 AI integration (SKILLY_SPEC.md §40.13). Gated behind
// SKILLY_DB_E2E=1; requires a migrated Postgres (… 0084) at DATABASE_URL. The provider is a real
// local HTTP stub speaking the Anthropic Messages / models shapes.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Covers: save-fail persists nothing; save-pass persists an encrypted token + audits
// ai.config_updated (token_rotated true/false, never the token); identical save is a no-op; the
// stored token is refused for another base URL; enable is gated on the last test and audited;
// GET never contains the token; the helper records ai_usage (one row per retried call), updates
// last_call_*, and the 15-minute system_event throttle holds across concurrent failures; disable →
// ai_disabled; key missing → ai_key_missing; remove hard-deletes + audits and keeps ai_usage;
// the usage prune; GDPR erasure nulls ai_usage.user_id.
import { test } from "node:test";
import { withAiIntegrationLock } from "./aiTestLock";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const enabled = process.env.SKILLY_DB_E2E === "1";

const GOOD = "sk-dbtest-good-token-1234";
const AI_KEY_B64 = Buffer.alloc(32, 11).toString("base64");
const FEATURE = "dbtest_feature";

/** A tiny Anthropic-shaped provider. `mode` switches the completion answer. */
function startStub(): Promise<{ server: Server; url: string; state: { mode: "ok" | "500"; hits: number; keys: string[] } }> {
  const state = { mode: "ok" as "ok" | "500", hits: 0, keys: [] as string[] };
  const server = createServer((req, res) => {
    state.hits++;
    const key = String(req.headers["x-api-key"] ?? "");
    state.keys.push(key);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (key !== GOOD) {
        res.statusCode = 401;
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${key}` } }));
        return;
      }
      if (req.url?.startsWith("/v1/models")) {
        res.end(JSON.stringify({ data: [{ id: "stub-model-b" }, { id: "stub-model-a" }] }));
        return;
      }
      if (req.url === "/v1/messages") {
        if (state.mode === "500") {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: { message: "stub overloaded" } }));
          return;
        }
        const model = (JSON.parse(body) as { model: string }).model;
        res.end(JSON.stringify({ model, content: [{ type: "text", text: "OK" }], usage: { input_tokens: 7, output_tokens: 1 } }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state })),
  );
}

test("AI integration: save/test/enable/helper/remove against a live DB", { skip: !enabled }, () => withAiIntegrationLock(async () => {
  process.env.AI_TOKEN_ENC_KEY = AI_KEY_B64;
  const { pool } = await import("./db");
  const ai = await import("./ai");
  const shared = await import("@skilly/shared/ai");
  const { eraseUser } = await import("./eraseUser");
  const stub = await startStub();

  const upsertUser = async (oid: string, email: string, name: string) =>
    (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name, status) values ($1,$2,$3,'active')
       on conflict (entra_object_id) do update set email = excluded.email, display_name = excluded.display_name, status = 'active' returning id`,
      [oid, email, name],
    )).rows[0]!.id;
  const audits = async (action: string, since: Date) =>
    (await pool.query<{ before: unknown; after: Record<string, unknown> | null }>(
      `select before, after from audit_log where action = $1 and created_at >= $2 order by created_at`,
      [action, since],
    )).rows;

  try {
    const actor = await upsertUser("ai-dbtest-admin", "aiadmin@t", "AI Admin");
    await pool.query(`delete from ai_integration`);
    await pool.query(`delete from ai_usage where feature in ('test', $1)`, [FEATURE]);
    const t0 = new Date(Date.now() - 1000);

    // Not configured.
    let st = await ai.getAiAdminStatus();
    assert.equal(st.configured, false);
    assert.equal(st.status, "not_configured");
    assert.equal(st.keyConfigured, true);

    // Save with a bad token → the test fails → 422, nothing persisted, one failed test usage row.
    const bad = await ai.saveFromForm({ provider: "anthropic", baseUrl: stub.url, model: "stub-model-a", token: "sk-wrong-9999" }, actor);
    assert.ok(ai.isAiApiError(bad));
    assert.equal(bad.error, "ai_test_failed");
    assert.equal(bad.status, 422);
    assert.ok(!String(bad.detail).includes("sk-wrong-9999"), "provider error text is token-redacted");
    assert.equal((await pool.query(`select 1 from ai_integration`)).rowCount, 0);
    const failedTests = await pool.query<{ ok: boolean }>(`select ok from ai_usage where feature = 'test' and user_id = $1`, [actor]);
    assert.deepEqual(failedTests.rows.map((r) => r.ok), [false]);

    // Save with the good token → persisted, encrypted, audited with token_rotated: true.
    const saved = await ai.saveFromForm({ provider: "anthropic", baseUrl: stub.url + "/", model: "stub-model-a", token: GOOD }, actor);
    assert.ok(!ai.isAiApiError(saved), JSON.stringify(saved));
    assert.equal(saved.unchanged, false);
    const raw = (await pool.query<{ token_enc: string; token_last4: string; base_url: string; enabled: boolean }>(`select token_enc, token_last4, base_url, enabled from ai_integration`)).rows[0]!;
    assert.ok(!raw.token_enc.includes(GOOD));
    assert.equal(raw.token_last4, "1234");
    assert.equal(raw.base_url, stub.url, "trailing slash normalized");
    assert.equal(raw.enabled, false, "saving never switches it on");
    let upd = await audits("ai.config_updated", t0);
    assert.equal(upd.length, 1);
    assert.equal(upd[0]!.after!.token_rotated, true);
    assert.ok(!JSON.stringify(upd[0]).includes(GOOD) && !JSON.stringify(upd[0]).includes("1234"), "audit never carries the token");

    // Identical values (blank token) → no-op: no test call, no audit.
    const hitsBefore = stub.state.hits;
    const same = await ai.saveFromForm({ provider: "anthropic", baseUrl: stub.url, model: "stub-model-a", token: "" }, actor);
    assert.ok(!ai.isAiApiError(same) && same.unchanged);
    assert.equal(stub.state.hits, hitsBefore);

    // Model change with the stored token → tested, saved, token_rotated: false.
    const remodel = await ai.saveFromForm({ provider: "anthropic", baseUrl: stub.url, model: "stub-model-b" }, actor);
    assert.ok(!ai.isAiApiError(remodel) && !remodel.unchanged);
    upd = await audits("ai.config_updated", t0);
    assert.equal(upd.length, 2);
    assert.equal(upd[1]!.after!.token_rotated, false);
    assert.deepEqual(upd[1]!.before, { provider: "anthropic", baseUrl: stub.url, model: "stub-model-a" });

    // The stored token is never sent to another base URL or provider.
    const elsewhere = await ai.testFromForm({ provider: "anthropic", baseUrl: "http://127.0.0.1:1", model: "x" }, actor);
    assert.ok(ai.isAiApiError(elsewhere) && elsewhere.error === "ai_token_required");
    const otherProvider = await ai.listModelsForForm({ provider: "openwebui", baseUrl: stub.url });
    assert.ok(ai.isAiApiError(otherProvider) && otherProvider.error === "ai_token_required");

    // Model list with the stored token (same provider + URL).
    const models = await ai.listModelsForForm({ provider: "anthropic", baseUrl: stub.url });
    assert.deepEqual(models, { models: ["stub-model-a", "stub-model-b"] });

    // GET never contains the token.
    st = await ai.getAiAdminStatus();
    assert.ok(!JSON.stringify(st).includes(GOOD));
    assert.equal(st.tokenLast4, "1234");
    assert.equal(st.status, "off");
    assert.equal(st.canEnable, true);

    // Enable is gated on the latest test of the saved config.
    await pool.query(`update ai_integration set last_test_ok = false`);
    const gated = await ai.setAiEnabled(true, actor);
    assert.ok(ai.isAiApiError(gated) && gated.error === "ai_test_required" && gated.status === 409);
    // A manual test of the saved config refreshes last_test_*.
    const retest = await ai.testFromForm({ provider: "anthropic", baseUrl: stub.url, model: "stub-model-b" }, actor);
    assert.ok(!ai.isAiApiError(retest) && retest.ok);
    assert.equal((await pool.query<{ last_test_ok: boolean }>(`select last_test_ok from ai_integration`)).rows[0]!.last_test_ok, true);
    const on = await ai.setAiEnabled(true, actor);
    assert.deepEqual(on, { ok: true, enabled: true });
    assert.equal((await audits("ai.enabled", t0)).length, 1);
    st = await ai.getAiAdminStatus();
    assert.equal(st.status, "operational");

    // The helper (shared, bound to the live pool with an injected registry).
    const env = { key: Buffer.from(AI_KEY_B64, "base64"), source: "web" as const, features: [{ key: FEATURE, label: "DB test", egress: "nothing real", spec: "§40.13" }], sleep: async () => {} };
    const r = await shared.aiComplete(pool, env, { feature: FEATURE, userId: actor, messages: [{ role: "user", content: "hi" }], maxTokens: 8 });
    assert.equal(r.text, "OK");
    assert.equal(r.inputTokens, 7);
    const okRow = (await pool.query<{ ok: boolean; user_id: string; model: string }>(`select ok, user_id, model from ai_usage where feature = $1`, [FEATURE])).rows;
    assert.deepEqual(okRow, [{ ok: true, user_id: actor, model: "stub-model-b" }]);

    // Failures: 500 is retried once (one usage row per call); two concurrent failures log ONE system_event.
    await pool.query(`update ai_integration set last_failure_logged_at = null`);
    const evBefore = new Date();
    stub.state.mode = "500";
    const hits0 = stub.state.hits;
    const results = await Promise.allSettled([
      shared.aiComplete(pool, env, { feature: FEATURE, messages: [{ role: "user", content: "a" }], maxTokens: 8 }),
      shared.aiComplete(pool, { ...env, source: "worker" }, { feature: FEATURE, messages: [{ role: "user", content: "b" }], maxTokens: 8 }),
    ]);
    assert.ok(results.every((x) => x.status === "rejected" && (x.reason as InstanceType<typeof shared.AiError>).code === "ai_provider_error"));
    assert.equal(stub.state.hits - hits0, 4, "each call retried once");
    const failRows = await pool.query(`select 1 from ai_usage where feature = $1 and not ok`, [FEATURE]);
    assert.equal(failRows.rowCount, 2, "one usage row per call, not per attempt");
    const events = await pool.query<{ status: number; method: string; route: string; path: string; error_code: string; message: string }>(
      `select status, method, route, path, error_code, message from system_event where route = $1 and created_at >= $2`,
      [`ai:${FEATURE}`, evBefore],
    );
    assert.equal(events.rowCount, 1, "15-minute throttle holds across concurrent failures");
    assert.deepEqual(
      { ...events.rows[0]!, message: undefined },
      { status: 502, method: "AI", route: `ai:${FEATURE}`, path: "/v1/messages", error_code: "ai_provider_error", message: undefined },
    );
    assert.ok(!events.rows[0]!.message.includes(GOOD));
    st = await ai.getAiAdminStatus();
    assert.equal(st.status, "failing");
    assert.match(st.statusReason ?? "", /ai_provider_error/);
    stub.state.mode = "ok";

    // Disable → the helper refuses before the network.
    assert.deepEqual(await ai.setAiEnabled(false, actor), { ok: true, enabled: false });
    assert.equal((await audits("ai.disabled", t0)).length, 1);
    const hits1 = stub.state.hits;
    await assert.rejects(shared.aiComplete(pool, env, { feature: FEATURE, messages: [{ role: "user", content: "x" }], maxTokens: 8 }), (e: unknown) => (e as { code: string }).code === "ai_disabled");
    assert.equal(stub.state.hits, hits1);

    // Key missing → every write is refused.
    delete process.env.AI_TOKEN_ENC_KEY;
    const nokey = await ai.setAiEnabled(true, actor);
    assert.ok(ai.isAiApiError(nokey) && nokey.error === "ai_key_missing" && nokey.status === 409);
    assert.equal((await ai.getAiAdminStatus()).keyConfigured, false);
    process.env.AI_TOKEN_ENC_KEY = AI_KEY_B64;

    // GDPR erasure nulls ai_usage.user_id (rows kept).
    const target = await upsertUser("ai-dbtest-target", "aitarget@t", "AI Target");
    await shared.recordAiUsage(pool, { feature: FEATURE, userId: target, provider: "anthropic", model: "m", inputTokens: 1, outputTokens: 1, latencyMs: 1, ok: true, errorCode: null });
    const erased = await eraseUser(actor, target, null);
    assert.ok(erased.ok, JSON.stringify(erased));
    const after = await pool.query<{ user_id: string | null }>(`select user_id from ai_usage where feature = $1 and model = 'm'`, [FEATURE]);
    assert.deepEqual(after.rows, [{ user_id: null }]);

    // Remove → row gone, audited, usage kept; a second remove is a 404.
    const usageCount = (await pool.query(`select 1 from ai_usage where feature in ('test', $1)`, [FEATURE])).rowCount;
    assert.deepEqual(await ai.removeAiIntegration(actor), { ok: true });
    assert.equal((await pool.query(`select 1 from ai_integration`)).rowCount, 0);
    const cleared = await audits("ai.config_cleared", t0);
    assert.equal(cleared.length, 1);
    assert.ok(!JSON.stringify(cleared[0]).includes(GOOD));
    assert.equal((await pool.query(`select 1 from ai_usage where feature in ('test', $1)`, [FEATURE])).rowCount, usageCount);
    const again = await ai.removeAiIntegration(actor);
    assert.ok(ai.isAiApiError(again) && again.status === 404);
    assert.equal((await ai.getAiAdminStatus()).status, "not_configured");

    // Retention prune: > 365 days goes, recent stays.
    await pool.query(
      `insert into ai_usage (created_at, feature, provider, model, latency_ms, ok) values (now() - interval '400 days', $1, 'anthropic', 'old', 1, true)`,
      [FEATURE],
    );
    const pruned = await shared.pruneAiUsage(pool);
    assert.ok(pruned >= 1);
    assert.equal((await pool.query(`select 1 from ai_usage where feature = $1 and model = 'old'`, [FEATURE])).rowCount, 0);
    assert.ok(((await pool.query(`select 1 from ai_usage where feature = $1`, [FEATURE])).rowCount ?? 0) > 0);

    // The sequence grant shipped with the table (0075 rule).
    const grant = await pool.query<{ ok: boolean }>(`select has_sequence_privilege('skilly_app', 'ai_usage_id_seq', 'USAGE') as ok`);
    assert.equal(grant.rows[0]!.ok, true);
  } finally {
    await pool.query(`delete from ai_integration`).catch(() => {});
    await pool.query(`delete from ai_usage where feature in ('test', $1)`, [FEATURE]).catch(() => {});
    stub.server.close();
    await pool.end();
  }
}));
