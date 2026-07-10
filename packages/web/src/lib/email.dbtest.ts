// Live-DB integration test for the §12 email channel's web helpers: wrapper save
// (sanitize + placeholder contract + audit), channel status/pill resolution, and
// connect/disconnect audit rows. Gated behind SKILLY_DB_E2E=1:
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
import { test } from "node:test";
import assert from "node:assert/strict";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("email channel: wrapper save + status pill + connect/disconnect audit", { skip: !enabled }, async () => {
  process.env.EMAIL_TOKEN_ENC_KEY = Buffer.alloc(32, 5).toString("base64");
  process.env.ENTRA_TENANT_ID ??= "t";
  process.env.ENTRA_CLIENT_ID ??= "c";
  process.env.ENTRA_CLIENT_SECRET ??= "s";
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { getEmailChannelStatus, saveEmailWrapper, disconnectEmail, finishConnect, webGraphMailEnv } = await import("./email");
  try {
    const actor = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ('email-admin-oid','eadmin@t','EAdmin')
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
    )).rows[0]!.id;
    // Clean slate for local re-runs.
    await pool.query(`delete from email_service_account`);
    await pool.query(`delete from platform_settings where key = 'email_wrapper_html'`);

    // Not connected → pill down/smtp_fallback with reason not_connected.
    let status = await getEmailChannelStatus();
    assert.equal(status.connected, false);
    assert.equal(status.reason, "not_connected");

    // Wrapper contract: rejected without exactly one placeholder; sanitized on save; audited.
    assert.ok("error" in (await saveEmailWrapper("<p>none</p>", actor)));
    assert.ok("error" in (await saveEmailWrapper("<p>[SYSTEM MESSAGE][SYSTEM MESSAGE]</p>", actor)));
    const saved = await saveEmailWrapper(`<div onclick="x()">[SYSTEM MESSAGE]</div><script>bad()</script>`, actor);
    assert.ok("sanitized" in saved, JSON.stringify(saved));
    assert.equal((saved as { sanitized: string }).sanitized, "<div>[SYSTEM MESSAGE]</div>");
    const wrapperAudit = await pool.query(
      `select 1 from audit_log where action = 'email.template_updated' and actor_user_id = $1`,
      [actor],
    );
    assert.ok((wrapperAudit.rowCount ?? 0) >= 1, "template save audited");

    // Connect (store) → status reflects the account; audit records the (null) replaced UPN.
    const env = webGraphMailEnv()!;
    const tokens = { accessToken: "AT", refreshToken: "RT", expiresInSec: 3600, idToken: "x" };
    await finishConnect(env, { claims: { oid: "svc-oid", upn: "svc@t", name: "Svc" }, tokens, actorUserId: actor });
    status = await getEmailChannelStatus();
    assert.equal(status.connected, true);
    assert.equal(status.account?.upn, "svc@t");
    assert.equal(status.reason, null);
    assert.equal(status.pill, "operational");
    // Tokens are encrypted at rest — never the raw value.
    const rawRow = await pool.query<{ refresh_token_enc: string }>(`select refresh_token_enc from email_service_account`);
    assert.ok(!rawRow.rows[0]!.refresh_token_enc.includes("RT"));

    // Re-connect replaces atomically and records the replaced UPN in the audit payload.
    await finishConnect(env, { claims: { oid: "svc2-oid", upn: "svc2@t", name: "Svc2" }, tokens, actorUserId: actor });
    const reconnectAudit = await pool.query<{ after: { replacedUpn?: string } }>(
      `select after from audit_log where action = 'email.account_connected' and target_id = 'svc2@t' order by created_at desc limit 1`,
    );
    assert.equal(reconnectAudit.rows[0]!.after.replacedUpn, "svc@t");

    // Disconnect hard-deletes + audits.
    assert.equal(await disconnectEmail(actor), "svc2@t");
    assert.equal((await pool.query(`select 1 from email_service_account`)).rowCount, 0);
    const discAudit = await pool.query(`select 1 from audit_log where action = 'email.account_disconnected' and target_id = 'svc2@t'`);
    assert.ok((discAudit.rowCount ?? 0) >= 1, "disconnect audited");
  } finally {
    await pool.end();
  }
});
