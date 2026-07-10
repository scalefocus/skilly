// Operational-condition tests for the §12 Graph transport: connected + refreshable token +
// saved wrapper + enc key, else undefined (→ the sweep falls back to env SMTP / in-app).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { encryptToken, parseEmailTokenKey, type GraphMailEnv } from "@skilly/shared/email";
import { resolveGraphTransport } from "./graphChannel.js";

const KEY = parseEmailTokenKey(Buffer.alloc(32, 3).toString("base64"))!;

function fakeEnv(fetchImpl: typeof fetch): GraphMailEnv {
  return { tenantId: "t", clientId: "c", clientSecret: "s", key: KEY, fetchImpl, loginBase: "https://login.test", graphBase: "https://graph.test/v1.0" };
}

function fakePool(opts: { account: boolean; wrapper: string | null; refreshOk?: boolean }) {
  const account = opts.account
    ? {
        account_upn: "svc@corp.com",
        account_display_name: "Svc",
        account_oid: "o1",
        refresh_token_enc: encryptToken("R", KEY),
        access_token_enc: encryptToken("A", KEY),
        access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        connected_at: new Date().toISOString(),
        connected_by_user_id: null,
        last_refresh_at: null,
        last_refresh_error: null,
      }
    : null;
  const query = async (text: string) => {
    const t = text.trim().toLowerCase();
    if (t.includes("from email_service_account")) return { rows: account ? [account] : [], rowCount: account ? 1 : 0 };
    if (t.includes("from platform_settings")) return { rows: opts.wrapper ? [{ value: opts.wrapper }] : [], rowCount: opts.wrapper ? 1 : 0 };
    if (t === "begin" || t === "commit" || t === "rollback" || t.startsWith("update email_service_account")) return { rows: [], rowCount: null };
    throw new Error(`unexpected query: ${text}`);
  };
  return { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
}

test("not operational: env missing / no account / no wrapper", async () => {
  const okFetch: typeof fetch = async () => new Response(null, { status: 202 });
  assert.equal(await resolveGraphTransport(fakePool({ account: true, wrapper: "<p>[SYSTEM MESSAGE]</p>" }), null), undefined);
  assert.equal(await resolveGraphTransport(fakePool({ account: false, wrapper: "<p>[SYSTEM MESSAGE]</p>" }), fakeEnv(okFetch)), undefined);
  assert.equal(await resolveGraphTransport(fakePool({ account: true, wrapper: null }), fakeEnv(okFetch)), undefined);
});

test("operational: sends wrapped multipart mail via Graph with the same links + manage footer", async () => {
  const calls: { url: string; body: string }[] = [];
  const f: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: String((init as RequestInit).body ?? "") });
    return new Response(null, { status: 202 });
  };
  const transport = await resolveGraphTransport(fakePool({ account: true, wrapper: "<div>[SYSTEM MESSAGE]</div>" }), fakeEnv(f));
  assert.ok(transport);
  assert.equal(transport!.kind, "graph");
  await transport!.send("user@corp.com", {
    subject: "skilly: test",
    text: "View it: https://s.example/skills/global/pdf",
    webhook: {},
  });
  const send = calls.find((c) => c.url.includes("/me/sendMail"));
  assert.ok(send, "sendMail called");
  const mime = Buffer.from(send!.body, "base64").toString("utf8");
  assert.ok(mime.includes("To: user@corp.com"));
  assert.ok(mime.includes("multipart/alternative"));
  const html = Buffer.from(/Content-Type: text\/html[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(mime)![1]!.replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.ok(html.startsWith("<div>View it: ")); // wrapper substitution around the message text
  assert.ok(html.includes(`<a href="https://s.example/skills/global/pdf">`)); // clickable link

  assert.ok(html.includes("Manage email notifications")); // §12 footer always appended
});
