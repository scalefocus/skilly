// Web-side helpers for the §12 email channel: admin card status, wrapper save, connect /
// disconnect, and the test send. All callers are platform-admin-only routes (re-verified
// there). Tokens are handled exclusively through @skilly/shared/email — encrypted at rest,
// never logged, never in audit payloads. SKILLY_SPEC.md §12.
import { pool } from "./db";
import { appendAudit } from "./audit";
import {
  disconnectEmailAccount,
  ensureFreshAccessToken,
  getEmailAccount,
  getEmailWrapperHtml,
  parseEmailTokenKey,
  saveConnectedAccount,
  sendGraphMail,
  type AuthCodeTokens,
  type GraphMailEnv,
  type ServiceAccountClaims,
} from "@skilly/shared/email";
import { renderEmailText, renderWrappedEmailHtml, validateWrapperHtml } from "@skilly/shared";

/** One-shot cookies binding the connect redirect to this browser (state + PKCE verifier). */
export const EMAIL_OAUTH_STATE_COOKIE = "skilly.email.state";
export const EMAIL_OAUTH_VERIFIER_COOKIE = "skilly.email.verifier";

export function webBaseUrl(): string {
  return process.env.PUBLIC_BASE_URL ?? process.env.SKILLY_REGISTRY_URL ?? process.env.NEXTAUTH_URL ?? "";
}

/** Graph env for the web tier (connect flow + test send), or null when key/creds absent. */
export function webGraphMailEnv(): GraphMailEnv | null {
  const key = parseEmailTokenKey(process.env.EMAIL_TOKEN_ENC_KEY);
  const tenantId = process.env.ENTRA_TENANT_ID;
  const clientId = process.env.EMAIL_CLIENT_ID ?? process.env.ENTRA_CLIENT_ID;
  const clientSecret = process.env.EMAIL_CLIENT_SECRET ?? process.env.ENTRA_CLIENT_SECRET;
  if (!key || !tenantId || !clientId || !clientSecret) return null;
  return { tenantId, clientId, clientSecret, key };
}

export type EmailPill = "operational" | "smtp_fallback" | "down";
export type EmailDownReason = "no_key" | "not_connected" | "refresh_failing" | "no_wrapper";

export interface EmailChannelStatus {
  connected: boolean;
  account: { upn: string; displayName: string; connectedAt: string; connectedByName: string | null } | null;
  lastRefreshAt: string | null;
  lastRefreshError: string | null;
  wrapperHtml: string | null;
  encKeyPresent: boolean;
  smtpConfigured: boolean;
  /** The admin card's status pill (§12): Graph sending / SMTP fallback / email down. */
  pill: EmailPill;
  /** Why the Graph transport is non-operational (null when operational). */
  reason: EmailDownReason | null;
}

export async function getEmailChannelStatus(): Promise<EmailChannelStatus> {
  const encKeyPresent = webGraphMailEnv() !== null;
  const smtpConfigured = Boolean(process.env.SMTP_HOST);
  const [account, wrapperHtml] = await Promise.all([getEmailAccount(pool), getEmailWrapperHtml(pool)]);

  let connectedByName: string | null = null;
  if (account?.connectedByUserId) {
    const { rows } = await pool.query<{ display_name: string }>(`select display_name from users where id = $1`, [account.connectedByUserId]);
    connectedByName = rows[0]?.display_name ?? null;
  }

  // The web tier's snapshot of the Graph transport's operational conditions — the worker's
  // keep-alive refresh (every sweep) keeps last_refresh_error current (§12).
  const reason: EmailDownReason | null = !encKeyPresent
    ? "no_key"
    : !account
      ? "not_connected"
      : account.lastRefreshError
        ? "refresh_failing"
        : !wrapperHtml
          ? "no_wrapper"
          : null;

  return {
    connected: Boolean(account),
    account: account
      ? { upn: account.upn, displayName: account.displayName, connectedAt: account.connectedAt, connectedByName }
      : null,
    lastRefreshAt: account?.lastRefreshAt ?? null,
    lastRefreshError: account?.lastRefreshError ?? null,
    wrapperHtml,
    encKeyPresent,
    smtpConfigured,
    pill: reason === null ? "operational" : smtpConfigured ? "smtp_fallback" : "down",
    reason,
  };
}

/** Sanitize + validate (exactly one [SYSTEM MESSAGE]) + save the wrapper. Audited. */
export async function saveEmailWrapper(html: string, actorUserId: string): Promise<{ sanitized: string } | { error: string }> {
  const v = validateWrapperHtml(html);
  if (!v.ok) return { error: v.error };
  await pool.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ('email_wrapper_html', $1::jsonb, $2, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(v.sanitized), actorUserId],
  );
  await appendAudit(pool, {
    actorUserId,
    action: "email.template_updated",
    targetType: "platform_settings",
    targetId: "email_wrapper_html",
    after: { bytes: v.sanitized.length },
  });
  return { sanitized: v.sanitized };
}

/** Store/replace the connected account after the code exchange. Audited (never tokens). */
export async function finishConnect(
  env: GraphMailEnv,
  p: { claims: ServiceAccountClaims; tokens: AuthCodeTokens; actorUserId: string },
): Promise<void> {
  const { replacedUpn } = await saveConnectedAccount(pool, env, {
    claims: p.claims,
    tokens: p.tokens,
    connectedByUserId: p.actorUserId,
  });
  await appendAudit(pool, {
    actorUserId: p.actorUserId,
    action: "email.account_connected",
    targetType: "email_service_account",
    targetId: p.claims.upn,
    // Re-connect atomically replaces the single row — the replaced UPN is recorded here
    // instead of a separate disconnected event (§12).
    after: { upn: p.claims.upn, displayName: p.claims.name, replacedUpn },
  });
}

/** Disconnect (hard-deletes the row incl. tokens). Audited. Returns the removed UPN. */
export async function disconnectEmail(actorUserId: string): Promise<string | null> {
  const upn = await disconnectEmailAccount(pool);
  if (upn) {
    await appendAudit(pool, {
      actorUserId,
      action: "email.account_disconnected",
      targetType: "email_service_account",
      targetId: upn,
      after: { upn },
    });
  }
  return upn;
}

/** Send a §12 test email (current wrapper + a sample message) to the acting admin.
 *  Requires the channel operational; refreshes under the shared row lock. Unaudited —
 *  it mails only the actor. */
export async function sendTestEmail(actorUserId: string): Promise<{ ok: true; to: string } | { error: string }> {
  const env = webGraphMailEnv();
  if (!env) return { error: "EMAIL_TOKEN_ENC_KEY (or the Entra credentials) is not configured" };
  const wrapper = await getEmailWrapperHtml(pool);
  if (!wrapper) return { error: "save a message wrapper first — without one the Graph transport doesn't send" };
  const { rows } = await pool.query<{ email: string }>(`select email from users where id = $1`, [actorUserId]);
  const to = rows[0]?.email;
  if (!to) return { error: "your account has no email address" };
  const token = await ensureFreshAccessToken(pool, env);
  if (!token.ok) {
    return { error: token.reason === "not_connected" ? "no email service account is connected" : `token refresh failed — see the status pill (${token.error ?? "unknown error"})` };
  }
  const baseUrl = webBaseUrl();
  const text = `This is a test notification from skilly.\n\nIf you can read this, the email service account works.\n\nOpen skilly: ${baseUrl || "(PUBLIC_BASE_URL not set)"}`;
  try {
    await sendGraphMail(env, token.accessToken, {
      to,
      subject: "skilly: test email notification",
      text: renderEmailText(text, baseUrl),
      html: renderWrappedEmailHtml(wrapper, text, baseUrl),
    });
  } catch (err) {
    return { error: String((err as Error).message ?? err) };
  }
  return { ok: true, to };
}
