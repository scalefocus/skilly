import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptToken, decryptToken, parseEmailTokenKey } from "./email-crypto.js";
import {
  buildMimeMessage,
  ensureFreshAccessToken,
  sendGraphMail,
  GraphSendError,
  saveConnectedAccount,
  disconnectEmailAccount,
  parseIdTokenClaims,
  buildAuthorizeUrl,
  type DbPool,
  type GraphMailEnv,
} from "./email-graph.js";

const KEY = parseEmailTokenKey(Buffer.alloc(32, 7).toString("base64"))!;

function env(fetchImpl: typeof fetch): GraphMailEnv {
  return { tenantId: "t", clientId: "c", clientSecret: "s", key: KEY, fetchImpl, loginBase: "https://login.test", graphBase: "https://graph.test/v1.0" };
}

// ── crypto ─────────────────────────────────────────────────────────────────────────────────

test("token crypto: roundtrip + tamper detection + key validation", () => {
  const enc = encryptToken("secret-token", KEY);
  assert.equal(decryptToken(enc, KEY), "secret-token");
  const tampered = enc.slice(0, -4) + (enc.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.throws(() => decryptToken(tampered, KEY));
  assert.equal(parseEmailTokenKey(undefined), null);
  assert.equal(parseEmailTokenKey("too-short"), null);
});

// ── fake single-connection pool ────────────────────────────────────────────────────────────

interface Row { [k: string]: unknown }
function fakePool(state: { row: Row | null }): DbPool & { updates: Row[] } {
  const updates: Row[] = [];
  const query = async (text: string, params: unknown[] = []) => {
    const t = text.trim().toLowerCase();
    if (t === "begin" || t === "commit" || t === "rollback") return { rows: [], rowCount: null };
    if (t.startsWith("select") && t.includes("from email_service_account")) {
      return { rows: state.row ? [state.row] : [], rowCount: state.row ? 1 : 0 };
    }
    if (t.startsWith("update email_service_account")) {
      updates.push({ text, params });
      if (state.row) {
        if (t.includes("access_token_enc = $1")) {
          state.row.access_token_enc = params[0];
          state.row.access_token_expires_at = params[1];
          state.row.refresh_token_enc = params[2];
          state.row.last_refresh_error = null;
        } else {
          state.row.last_refresh_error = params[0];
        }
      }
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith("insert into email_service_account")) {
      state.row = {
        account_upn: params[0],
        account_display_name: params[1],
        account_oid: params[2],
        refresh_token_enc: params[3],
        access_token_enc: params[4],
        access_token_expires_at: params[5],
        connected_by_user_id: params[6],
        last_refresh_error: null,
      };
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith("delete from email_service_account")) {
      const upn = state.row?.account_upn ?? null;
      state.row = null;
      return { rows: upn ? [{ account_upn: upn }] : [], rowCount: upn ? 1 : 0 };
    }
    throw new Error(`unexpected query: ${text}`);
  };
  return { query, updates, connect: async () => ({ query, release() {} }) };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// ── refresh ────────────────────────────────────────────────────────────────────────────────

test("ensureFreshAccessToken: not connected", async () => {
  const pool = fakePool({ row: null });
  const r = await ensureFreshAccessToken(pool, env(async () => jsonResponse(200, {})));
  assert.deepEqual(r, { ok: false, reason: "not_connected" });
});

test("ensureFreshAccessToken: cached token still valid → no refresh call", async () => {
  let called = 0;
  const pool = fakePool({
    row: {
      refresh_token_enc: encryptToken("R1", KEY),
      access_token_enc: encryptToken("A1", KEY),
      access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    },
  });
  const r = await ensureFreshAccessToken(pool, env(async () => (called++, jsonResponse(200, {}))));
  assert.deepEqual(r, { ok: true, accessToken: "A1" });
  assert.equal(called, 0);
});

test("ensureFreshAccessToken: expired token → refresh, rotated refresh token re-stored", async () => {
  const state = {
    row: {
      refresh_token_enc: encryptToken("R1", KEY),
      access_token_enc: encryptToken("A1", KEY),
      access_token_expires_at: new Date(Date.now() - 1000).toISOString(),
    } as Row,
  };
  const pool = fakePool(state);
  const r = await ensureFreshAccessToken(
    pool,
    env(async (_url, init) => {
      const body = String((init as RequestInit).body);
      assert.ok(body.includes("grant_type=refresh_token"));
      assert.ok(body.includes("refresh_token=R1"));
      return jsonResponse(200, { access_token: "A2", refresh_token: "R2", expires_in: 3600 });
    }),
  );
  assert.deepEqual(r, { ok: true, accessToken: "A2" });
  assert.equal(decryptToken(state.row.refresh_token_enc as string, KEY), "R2"); // rotation persisted
  assert.equal(decryptToken(state.row.access_token_enc as string, KEY), "A2");
});

test("ensureFreshAccessToken: refresh failure records last_refresh_error (no token material)", async () => {
  const state = { row: { refresh_token_enc: encryptToken("R1", KEY), access_token_enc: null, access_token_expires_at: null } as Row };
  const pool = fakePool(state);
  const r = await ensureFreshAccessToken(pool, env(async () => new Response("invalid_grant", { status: 400 })));
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, "refresh_failed");
  assert.match(String(state.row.last_refresh_error), /400/);
  assert.ok(!String(state.row.last_refresh_error).includes("R1"));
});

test("ensureFreshAccessToken: a rejected fetch (network outage) records the error and returns refresh_failed", async () => {
  // A DNS/egress failure must behave exactly like an HTTP error — recorded for the pill,
  // returned as refresh_failed — NEVER thrown, or the delivery sweep would freeze instead of
  // degrading to SMTP/in-app (§12).
  const state = { row: { refresh_token_enc: encryptToken("R1", KEY), access_token_enc: null, access_token_expires_at: null } as Row };
  const pool = fakePool(state);
  const r = await ensureFreshAccessToken(
    pool,
    env(async () => {
      throw new Error("getaddrinfo ENOTFOUND login.microsoftonline.com");
    }),
  );
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, "refresh_failed");
  assert.match(String(state.row.last_refresh_error), /ENOTFOUND/);
});

test("ensureFreshAccessToken: wrong key records a decrypt error", async () => {
  const otherKey = parseEmailTokenKey(Buffer.alloc(32, 9).toString("base64"))!;
  const state = { row: { refresh_token_enc: encryptToken("R1", otherKey), access_token_enc: null, access_token_expires_at: null } as Row };
  const pool = fakePool(state);
  const r = await ensureFreshAccessToken(pool, env(async () => jsonResponse(200, {})));
  assert.equal(r.ok, false);
  assert.match(String(state.row.last_refresh_error), /EMAIL_TOKEN_ENC_KEY/);
});

// ── MIME + send ────────────────────────────────────────────────────────────────────────────

test("buildMimeMessage: multipart/alternative with base64 text + html parts, CRLF, encoded subject", () => {
  const mime = buildMimeMessage({ to: "a@b.c", subject: "héllo", text: "plain", html: "<p>rich</p>" });
  assert.ok(mime.includes("To: a@b.c\r\n"));
  assert.ok(mime.includes(`Subject: =?UTF-8?B?${Buffer.from("héllo", "utf8").toString("base64")}?=`));
  assert.ok(mime.includes('Content-Type: multipart/alternative; boundary="=_skilly_alt"'));
  assert.ok(mime.includes(Buffer.from("plain", "utf8").toString("base64")));
  assert.ok(mime.includes(Buffer.from("<p>rich</p>", "utf8").toString("base64")));
  assert.ok(mime.endsWith("--=_skilly_alt--\r\n"));
  assert.ok(!mime.includes("\n\n")); // CRLF discipline (no bare-LF blank lines)
});

test("buildMimeMessage: header injection via the recipient is neutralised", () => {
  const mime = buildMimeMessage({ to: "a@b.c\r\nBcc: evil@x", subject: "s", text: "t", html: "h" });
  assert.ok(!/\r\nBcc:/i.test(mime)); // the CRLF is stripped, so no NEW header line can start with Bcc:
});

test("sendGraphMail: 202 accepted; 429 throws GraphSendError with retryAfter", async () => {
  await sendGraphMail(env(async () => new Response(null, { status: 202 })), "AT", { to: "a@b.c", subject: "s", text: "t", html: "h" });
  try {
    await sendGraphMail(env(async () => new Response("slow down", { status: 429, headers: { "retry-after": "17" } })), "AT", { to: "a@b.c", subject: "s", text: "t", html: "h" });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof GraphSendError);
    assert.equal(e.status, 429);
    assert.equal(e.retryAfterSeconds, 17);
  }
});

// ── connect flow ───────────────────────────────────────────────────────────────────────────

test("parseIdTokenClaims: reads oid/preferred_username/name from the payload", () => {
  const payload = Buffer.from(JSON.stringify({ oid: "o1", preferred_username: "svc@corp.com", name: "Svc Mailbox" })).toString("base64url");
  const claims = parseIdTokenClaims(`h.${payload}.sig`);
  assert.deepEqual(claims, { oid: "o1", upn: "svc@corp.com", name: "Svc Mailbox" });
});

test("buildAuthorizeUrl: Mail.Send + offline_access + PKCE + select_account", () => {
  const url = buildAuthorizeUrl({ tenantId: "t", clientId: "c" }, { redirectUri: "https://s/api/admin/email/callback", state: "st", codeChallenge: "ch" });
  assert.ok(url.startsWith("https://login.microsoftonline.com/t/oauth2/v2.0/authorize?"));
  for (const part of ["Mail.Send", "offline_access", "code_challenge=ch", "prompt=select_account", "state=st"]) {
    assert.ok(decodeURIComponent(url).includes(part), part);
  }
});

test("saveConnectedAccount: replace semantics report the replaced UPN; disconnect returns it", async () => {
  const state = { row: null as Row | null };
  const pool = fakePool(state);
  const tokens = { accessToken: "A", refreshToken: "R", expiresInSec: 3600, idToken: "i" };
  const first = await saveConnectedAccount(pool, env(async () => jsonResponse(200, {})), { claims: { oid: "o", upn: "one@c", name: "One" }, tokens, connectedByUserId: "u1" });
  assert.equal(first.replacedUpn, null);
  const second = await saveConnectedAccount(pool, env(async () => jsonResponse(200, {})), { claims: { oid: "o2", upn: "two@c", name: "Two" }, tokens, connectedByUserId: "u1" });
  assert.equal(second.replacedUpn, "one@c");
  assert.equal(decryptToken(state.row!.refresh_token_enc as string, KEY), "R"); // stored encrypted
  assert.equal(await disconnectEmailAccount(pool), "two@c");
  assert.equal(await disconnectEmailAccount(pool), null);
});
