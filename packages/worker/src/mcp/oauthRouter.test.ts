// Integration tests for the worker's half of the §29 OAuth AS: the metadata documents, the code
// exchange (PKCE), refresh rotation, and REUSE DETECTION — the one behaviour where getting it
// wrong turns a stolen refresh token into permanent access.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { pkceChallenge } from "@skilly/shared";
import { mcpOAuthRouter, mcpHousekeeping } from "./oauthRouter.js";
import { fakePool, type FakePool } from "./testPool.js";
import { invalidateMcpSettingsCache } from "./settings.js";

const VERIFIER = "v".repeat(43);
const CHALLENGE = pkceChallenge(VERIFIER);
const REDIRECT = "http://127.0.0.1:8976/callback";

function app(fp: FakePool) {
  const a = express();
  a.use(mcpOAuthRouter(fp.pool));
  return a;
}

function base(): FakePool {
  const fp = fakePool();
  invalidateMcpSettingsCache();
  fp.on("from platform_settings", []);
  return fp;
}

/** A valid, unconsumed authorization code row. */
function codeRow(over: Record<string, unknown> = {}) {
  return [
    {
      token_id: "t-code",
      grant_id: "g-1",
      code_challenge: CHALLENGE,
      stored_redirect: REDIRECT,
      stored_resource: "https://skilly.example.com/mcp",
      used_at: null,
      expired: false,
      client_id_public: "mcp_abc",
      client_blocked: false,
      grant_revoked: false,
      ...over,
    },
  ];
}

function refreshRow(over: Record<string, unknown> = {}) {
  return [
    {
      token_id: "t-refresh",
      grant_id: "g-1",
      used_at: null,
      expired: false,
      grant_revoked: false,
      client_blocked: false,
      user_active: true,
      ...over,
    },
  ];
}

// ── Metadata ───────────────────────────────────────────────────────────────────────────────────

test("AS metadata advertises PKCE S256, public clients, and both grants", async () => {
  const fp = base();
  const res = await request(app(fp)).get("/.well-known/oauth-authorization-server");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(res.body.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(res.body.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.match(res.body.registration_endpoint, /\/oauth\/register$/);
});

test("protected-resource metadata names the MCP endpoint (both well-known forms)", async () => {
  const fp = base();
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const res = await request(app(fp)).get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.body.resource, /\/mcp$/);
    assert.deepEqual(res.body.bearer_methods_supported, ["header"]);
  }
});

test("a disabled registry advertises nothing", async () => {
  const fp = base();
  invalidateMcpSettingsCache();
  fp.on("from platform_settings", [{ key: "mcp_enabled", value: false }]);
  const md = await request(app(fp)).get("/.well-known/oauth-authorization-server");
  assert.equal(md.status, 503);
  const tok = await request(app(fp)).post("/oauth/token").send({ grant_type: "authorization_code" });
  assert.equal(tok.status, 503);
  assert.equal(tok.body.error, "temporarily_unavailable");
});

// ── Authorization-code exchange ────────────────────────────────────────────────────────────────

test("a valid code + verifier mints an access + refresh pair", async () => {
  const fp = base();
  fp.on("where t.kind = 'code'", codeRow());
  fp.on("update oauth_tokens set used_at = now()", [{ ok: true }]);
  const res = await request(app(fp)).post("/oauth/token").send({
    grant_type: "authorization_code",
    code: "the-code",
    code_verifier: VERIFIER,
    redirect_uri: REDIRECT,
    client_id: "mcp_abc",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.token_type, "Bearer");
  assert.ok(res.body.access_token && res.body.refresh_token);
  assert.ok(res.body.expires_in > 0);
  assert.equal(res.headers["cache-control"], "no-store");
  // Only hashes are persisted — the raw values exist solely in this response.
  const insert = fp.matching("insert into oauth_tokens")[0]!;
  for (const p of insert.params) {
    assert.notEqual(p, res.body.access_token);
    assert.notEqual(p, res.body.refresh_token);
  }
});

test("a wrong PKCE verifier is refused", async () => {
  const fp = base();
  fp.on("where t.kind = 'code'", codeRow());
  const res = await request(app(fp)).post("/oauth/token").send({
    grant_type: "authorization_code",
    code: "the-code",
    code_verifier: "w".repeat(43),
    redirect_uri: REDIRECT,
    client_id: "mcp_abc",
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error_description, /PKCE/);
});

test("a mismatched redirect_uri or client_id is refused", async () => {
  for (const over of [{ redirect_uri: "http://127.0.0.1:8976/other" }, { client_id: "mcp_other" }]) {
    const fp = base();
    fp.on("where t.kind = 'code'", codeRow());
    const res = await request(app(fp))
      .post("/oauth/token")
      .send({
        grant_type: "authorization_code",
        code: "the-code",
        code_verifier: VERIFIER,
        redirect_uri: REDIRECT,
        client_id: "mcp_abc",
        ...over,
      });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_grant");
  }
});

test("a REPLAYED authorization code revokes the whole grant", async () => {
  const fp = base();
  fp.on("where t.kind = 'code'", codeRow({ used_at: new Date().toISOString() }));
  const res = await request(app(fp)).post("/oauth/token").send({
    grant_type: "authorization_code",
    code: "the-code",
    code_verifier: VERIFIER,
    redirect_uri: REDIRECT,
    client_id: "mcp_abc",
  });
  assert.equal(res.status, 400);
  assert.equal(fp.matching("update oauth_grants set revoked_at").length, 1);
  assert.equal(fp.matching("insert into oauth_tokens").length, 0, "nothing may be issued for a replayed code");
});

test("a blocked client can't exchange a code", async () => {
  const fp = base();
  fp.on("where t.kind = 'code'", codeRow({ client_blocked: true }));
  const res = await request(app(fp)).post("/oauth/token").send({
    grant_type: "authorization_code",
    code: "the-code",
    code_verifier: VERIFIER,
    redirect_uri: REDIRECT,
    client_id: "mcp_abc",
  });
  assert.equal(res.body.error, "invalid_client");
});

test("a resource indicator for someone else's server is refused (RFC 8707)", async () => {
  const fp = base();
  fp.on("where t.kind = 'code'", codeRow());
  const res = await request(app(fp)).post("/oauth/token").send({
    grant_type: "authorization_code",
    code: "the-code",
    code_verifier: VERIFIER,
    redirect_uri: REDIRECT,
    client_id: "mcp_abc",
    resource: "https://someone-else.example.com/mcp",
  });
  assert.equal(res.body.error, "invalid_target");
});

test("an unsupported grant type is named as such", async () => {
  const fp = base();
  const res = await request(app(fp)).post("/oauth/token").send({ grant_type: "client_credentials" });
  assert.equal(res.body.error, "unsupported_grant_type");
});

// ── Refresh rotation + reuse detection ─────────────────────────────────────────────────────────

test("a refresh mints a NEW pair and records the rotation lineage", async () => {
  const fp = base();
  fp.on("where t.kind = 'refresh'", refreshRow());
  fp.on("update oauth_tokens set used_at = now()", [{ ok: true }]);
  const res = await request(app(fp)).post("/oauth/token").send({ grant_type: "refresh_token", refresh_token: "old" });
  assert.equal(res.status, 200);
  assert.ok(res.body.refresh_token);
  const insert = fp.matching("insert into oauth_tokens")[0]!;
  // The last parameter is rotated_from_id — the lineage that makes reuse detection possible.
  assert.equal(insert.params.at(-1), "t-refresh");
  // The presented token is consumed: single-use.
  assert.equal(fp.matching("update oauth_tokens set used_at = now()").length, 1);
});

test("replaying an ALREADY-ROTATED refresh token revokes the entire grant", async () => {
  const fp = base();
  fp.on("where t.kind = 'refresh'", refreshRow({ used_at: new Date().toISOString() }));
  const res = await request(app(fp)).post("/oauth/token").send({ grant_type: "refresh_token", refresh_token: "old" });
  assert.equal(res.status, 400);
  assert.match(res.body.error_description, /revoked/);
  assert.equal(fp.matching("update oauth_grants set revoked_at").length, 1);
  assert.equal(fp.matching("insert into oauth_tokens").length, 0);
  // The live credentials are expired immediately, not left to age out.
  assert.ok(fp.matching("update oauth_tokens set expires_at = now()").length >= 1);
});

test("a refresh for an inactive owner or revoked grant is refused", async () => {
  for (const over of [{ user_active: false }, { grant_revoked: true }, { expired: true }]) {
    const fp = base();
    fp.on("where t.kind = 'refresh'", refreshRow(over));
    const res = await request(app(fp)).post("/oauth/token").send({ grant_type: "refresh_token", refresh_token: "x" });
    assert.equal(res.status, 400);
    assert.equal(fp.matching("insert into oauth_tokens").length, 0);
  }
});

// ── Revocation ─────────────────────────────────────────────────────────────────────────────────

test("revocation always answers 200 — no probing oracle — and takes the grant down", async () => {
  const fp = base();
  fp.on("select grant_id from oauth_tokens", [{ grant_id: "g-1" }]);
  const hit = await request(app(fp)).post("/oauth/revoke").send({ token: "whatever" });
  assert.equal(hit.status, 200);
  assert.equal(fp.matching("update oauth_grants set revoked_at").length, 1);

  const fp2 = base();
  fp2.on("select grant_id from oauth_tokens", []);
  const miss = await request(app(fp2)).post("/oauth/revoke").send({ token: "unknown" });
  assert.equal(miss.status, 200, "an unknown token must look exactly like a known one");
});

// ── Housekeeping ───────────────────────────────────────────────────────────────────────────────

test("housekeeping prunes dead tokens and never-used client registrations", async () => {
  const fp = base();
  fp.on("delete from oauth_tokens", [{}, {}]);
  fp.on("delete from oauth_clients", [{}]);
  const out = await mcpHousekeeping(fp.pool);
  assert.deepEqual(out, { tokens: 2, clients: 1 });
  const clients = fp.matching("delete from oauth_clients")[0]!;
  // Only registrations that never produced a grant, and only after the 7-day window.
  assert.match(clients.sql, /last_used_at is null/);
  assert.match(clients.sql, /7 days/);
  assert.match(clients.sql, /not exists \(select 1 from oauth_grants/);
});
