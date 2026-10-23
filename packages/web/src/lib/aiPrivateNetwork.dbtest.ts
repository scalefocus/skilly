// Live-DB integration test for the §40.16 private-network switch. Gated behind SKILLY_DB_E2E=1;
// requires a migrated Postgres at DATABASE_URL. The provider is a local Anthropic-shaped HTTP stub
// reached under a made-up host name that a stub resolver answers with 10.0.30.3, so the egress
// guard sees a private-network provider exactly as it would on a corporate network.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Covers: the switch works with no config and no key (no test) and audits settings.updated; an
// unchanged save is a no-op; with the switch off the form refuses the private host (models / test /
// save → ai_base_url_private naming the switch); on, the config saves; switching off re-tests and
// turns an enabled integration Failing, and the helper's runtime call is refused before the network;
// switching on re-tests, writes last_test_* and one test usage row, and turns it Operational; GET
// returns privateNetwork with operatorAllowed following the env var; the setting survives remove.
import { test } from "node:test";
import { withAiIntegrationLock } from "./aiTestLock";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// This file tests the guard itself: never inherit the operator's allow-everything opt-in.
delete process.env.AI_ALLOW_PRIVATE_BASE_URL;

const enabled = process.env.SKILLY_DB_E2E === "1";

const GOOD = "sk-dbtest-private-net-5678";
const AI_KEY_B64 = Buffer.alloc(32, 12).toString("base64");
const HOST = "owui.corp.example";
const FEATURE = "dbtest_private_network";
const SETTING = "ai_allow_private_network";

function startStub(): Promise<{ server: Server; port: number; state: { hits: number } }> {
  const state = { hits: 0 };
  const server = createServer((req, res) => {
    state.hits++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.headers["x-api-key"] !== GOOD) {
        res.statusCode = 401;
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
        return;
      }
      if (req.url?.startsWith("/v1/models")) {
        res.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
        return;
      }
      const model = (JSON.parse(body || "{}") as { model?: string }).model ?? "stub-model";
      res.end(JSON.stringify({ model, content: [{ type: "text", text: "OK" }], usage: { input_tokens: 3, output_tokens: 1 } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, state })));
}

test("AI private-network switch (§40.16) against a live DB", { skip: !enabled }, () => withAiIntegrationLock(async () => {
  process.env.AI_TOKEN_ENC_KEY = AI_KEY_B64;
  const { pool } = await import("./db");
  const ai = await import("./ai");
  const shared = await import("@skilly/shared/ai");
  const { aiHostGuard } = await import("@skilly/shared/ai-egress");
  const stub = await startStub();
  const baseUrl = `http://${HOST}:${stub.port}`;
  const resolve = async (h: string) => {
    if (h === HOST) return [{ address: "10.0.30.3" }];
    throw new Error(`ENOTFOUND ${h}`);
  };
  // The made-up host answers with a private address; the request itself goes to the loopback stub.
  ai.__setAiResolveForTests(resolve);
  ai.__setAiFetchForTests(((url: string | URL | Request, init?: RequestInit) => fetch(String(url).replace(`//${HOST}:`, "//127.0.0.1:"), init)) as typeof fetch);

  const actor = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status) values ('ai-privnet-dbtest-admin', 'aiprivnet@t', 'AI PrivNet Admin', 'active')
     on conflict (entra_object_id) do update set status = 'active' returning id`,
  )).rows[0]!.id;
  const audits = async (since: Date) =>
    (await pool.query<{ before: unknown; after: unknown }>(
      `select before, after from audit_log where action = 'settings.updated' and target_id = $1 and created_at >= $2 order by created_at`,
      [SETTING, since],
    )).rows;
  const testRows = async () => (await pool.query<{ ok: boolean; error_code: string | null }>(`select ok, error_code from ai_usage where feature = 'test' and user_id = $1 order by id`, [actor])).rows;
  const form = { provider: "anthropic", baseUrl, model: "stub-model", token: GOOD };

  try {
    await pool.query(`delete from ai_integration`);
    await pool.query(`delete from platform_settings where key = $1`, [SETTING]);
    await pool.query(`delete from ai_usage where user_id = $1 or feature = $2`, [actor, FEATURE]);
    const t0 = new Date(Date.now() - 1000);

    // Off by default; GET reports it, and the operator's env var is not set.
    let st = await ai.getAiAdminStatus();
    assert.deepEqual(st.privateNetwork, { enabled: false, operatorAllowed: false });

    // Off: every form action refuses the private host, naming the switch.
    const models = await ai.listModelsForForm(form);
    assert.ok(ai.isAiApiError(models));
    assert.equal(models.error, "ai_models_failed");
    assert.match(String(models.detail), /resolves to a private address \(10\.0\.30\.3\).*A platform admin can allow private-network providers/);
    const tested = await ai.testFromForm(form, actor);
    assert.ok(!ai.isAiApiError(tested));
    assert.equal(tested.ok, false);
    assert.equal(tested.errorCode, "ai_base_url_private");
    const refusedSave = await ai.saveFromForm(form, actor);
    assert.ok(ai.isAiApiError(refusedSave));
    assert.equal(refusedSave.error, "ai_test_failed");
    assert.equal(stub.state.hits, 0, "the guard refuses before any request");
    // A literal private IP is refused at save time with the same code.
    const literal = await ai.saveFromForm({ ...form, baseUrl: "http://10.0.30.3:8080" }, actor);
    assert.ok(ai.isAiApiError(literal));
    assert.equal(literal.error, "ai_base_url_private");

    // On with no config: saved, audited, no test; works without the key too.
    delete process.env.AI_TOKEN_ENC_KEY;
    const onNoConfig = await ai.setAiAllowPrivateNetwork(true, actor);
    assert.deepEqual(onNoConfig, { enabled: true, operatorAllowed: false, test: null });
    process.env.AI_TOKEN_ENC_KEY = AI_KEY_B64;
    assert.deepEqual(await audits(t0), [{ before: { aiAllowPrivateNetwork: false }, after: { aiAllowPrivateNetwork: true } }]);
    // Unchanged: no write, no audit, no test.
    assert.deepEqual(await ai.setAiAllowPrivateNetwork(true, actor), { enabled: true, operatorAllowed: false, test: null });
    assert.equal((await audits(t0)).length, 1);

    // On: the literal private IP passes the save-time check, and the config saves through the 10.x host.
    assert.equal(shared.normalizeAiBaseUrl("anthropic", "http://10.0.30.3:8080", { policy: "private_network" }).ok, true);
    const saved = await ai.saveFromForm(form, actor);
    assert.ok(!ai.isAiApiError(saved), JSON.stringify(saved));
    assert.deepEqual(await ai.setAiEnabled(true, actor), { ok: true, enabled: true });
    st = await ai.getAiAdminStatus();
    assert.equal(st.status, "operational");
    assert.equal(st.privateNetwork.enabled, true);

    // Off with a saved config: the re-test runs under the new setting and fails → Failing.
    const usageBefore = (await testRows()).length;
    const off = await ai.setAiAllowPrivateNetwork(false, actor);
    assert.equal(off.enabled, false);
    assert.ok(off.test && !off.test.ok);
    assert.equal(off.test.errorCode, "ai_base_url_private");
    assert.equal((await testRows()).length, usageBefore + 1, "one test usage row");
    st = await ai.getAiAdminStatus();
    assert.equal(st.status, "failing");
    assert.match(String(st.statusReason), /^ai_base_url_private: .*A platform admin can allow private-network providers/);
    assert.equal(st.lastTest.ok, false);
    assert.equal(st.canEnable, false, "a failing re-test fails the enable gate");

    // The runtime helper reads the switch with the config: off → refused before the network.
    const env = { key: Buffer.from(AI_KEY_B64, "base64"), source: "web" as const, features: [{ key: FEATURE, label: "x", egress: "x", spec: "§40.16" }], fetchImpl: ((url: string | URL | Request, init?: RequestInit) => fetch(String(url).replace(`//${HOST}:`, "//127.0.0.1:"), init)) as typeof fetch, hostGuard: aiHostGuard({ allowAll: false, resolve }), sleep: async () => {} };
    const hitsBefore = stub.state.hits;
    await assert.rejects(shared.aiComplete(pool, env, { feature: FEATURE, messages: [{ role: "user", content: "hi" }], maxTokens: 4 }), (e: unknown) => (e as { code: string }).code === "ai_base_url_private");
    assert.equal(stub.state.hits, hitsBefore);

    // On again: the re-test passes → Operational, last_test_* written; the runtime call goes through.
    const on = await ai.setAiAllowPrivateNetwork(true, actor);
    assert.ok(on.test?.ok, JSON.stringify(on.test));
    st = await ai.getAiAdminStatus();
    assert.equal(st.status, "operational");
    assert.equal(st.lastTest.ok, true);
    assert.equal(st.canEnable, true);
    const r = await shared.aiComplete(pool, env, { feature: FEATURE, messages: [{ role: "user", content: "hi" }], maxTokens: 4 });
    assert.equal(r.text, "OK");
    assert.equal((await audits(t0)).length, 3, "every change audited, the re-tests are not");

    // The operator's env var: GET reports it.
    process.env.AI_ALLOW_PRIVATE_BASE_URL = "1";
    assert.equal((await ai.getAiAdminStatus()).privateNetwork.operatorAllowed, true);
    delete process.env.AI_ALLOW_PRIVATE_BASE_URL;

    // The setting survives Remove integration.
    assert.deepEqual(await ai.removeAiIntegration(actor), { ok: true });
    st = await ai.getAiAdminStatus();
    assert.equal(st.status, "not_configured");
    assert.deepEqual(st.privateNetwork, { enabled: true, operatorAllowed: false });
  } finally {
    ai.__setAiResolveForTests(undefined);
    ai.__setAiFetchForTests(undefined);
    delete process.env.AI_ALLOW_PRIVATE_BASE_URL;
    await pool.query(`delete from ai_integration`).catch(() => {});
    await pool.query(`delete from platform_settings where key = $1`, [SETTING]).catch(() => {});
    await pool.query(`delete from ai_usage where user_id = $1 or feature = $2`, [actor, FEATURE]).catch(() => {});
    stub.server.close();
    await pool.end();
  }
}));
