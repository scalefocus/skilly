// The §12 Graph email transport: delegated-token refresh (serialized through the single
// email_service_account row), Microsoft Graph sendMail over a hand-built MIME
// multipart/alternative message, and the OAuth helpers the web connect flow uses.
// SERVER-ONLY — exported via "@skilly/shared/email". DB access is injected as a minimal
// pg-compatible shape so web (pool) and worker (pool) share one implementation and tests
// run against fakes. SKILLY_SPEC.md §12.
import { createHash, randomBytes } from "node:crypto";
import { decryptToken, encryptToken } from "./email-crypto.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface DbClient {
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
/** pg.Pool-compatible: query for single statements, connect() for the FOR UPDATE transaction. */
export interface DbPool extends DbClient {
  connect(): Promise<DbClient & { release(): void }>;
}

export interface GraphMailEnv {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Parsed EMAIL_TOKEN_ENC_KEY (32 bytes). */
  key: Buffer;
  /** Override points for tests. */
  loginBase?: string;
  graphBase?: string;
  fetchImpl?: typeof fetch;
}

/** Delegated scopes: Mail.Send to send, offline_access for the rotating refresh token. */
export const GRAPH_MAIL_SCOPES = "openid profile email offline_access https://graph.microsoft.com/Mail.Send";

const LOGIN_BASE = "https://login.microsoftonline.com";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
/** Refresh when the cached access token has less than this validity left. */
const MIN_TOKEN_VALIDITY_MS = 120_000;

// ── Account row ────────────────────────────────────────────────────────────────────────────

export interface EmailAccountView {
  upn: string;
  displayName: string;
  oid: string;
  connectedAt: string;
  connectedByUserId: string | null;
  lastRefreshAt: string | null;
  lastRefreshError: string | null;
  accessTokenExpiresAt: string | null;
}

/** The connected service account (no token material), or null when none is connected. */
export async function getEmailAccount(db: DbClient): Promise<EmailAccountView | null> {
  const { rows } = await db.query(
    `select account_upn, account_display_name, account_oid, connected_at, connected_by_user_id,
            last_refresh_at, last_refresh_error, access_token_expires_at
       from email_service_account`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    upn: r.account_upn,
    displayName: r.account_display_name,
    oid: r.account_oid,
    connectedAt: r.connected_at,
    connectedByUserId: r.connected_by_user_id,
    lastRefreshAt: r.last_refresh_at,
    lastRefreshError: r.last_refresh_error,
    accessTokenExpiresAt: r.access_token_expires_at,
  };
}

/** The saved §12 wrapper HTML (platform_settings.email_wrapper_html), or null. */
export async function getEmailWrapperHtml(db: DbClient): Promise<string | null> {
  const { rows } = await db.query(`select value from platform_settings where key = 'email_wrapper_html'`);
  const v = rows[0]?.value;
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

// ── Token refresh (serialized) ─────────────────────────────────────────────────────────────

export type FreshTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "not_connected" | "refresh_failed"; error?: string };

/**
 * Return a valid access token, refreshing via the stored refresh token when needed.
 * Serialized with SELECT … FOR UPDATE on the single row — Entra ROTATES refresh tokens on
 * use, so two uncoordinated refreshers would invalidate the token family; the rotated token
 * is re-stored before commit. Refresh failures are recorded (last_refresh_error/_at) and
 * surfaced only via the admin card's status pill (§12 — no notification spam).
 */
export async function ensureFreshAccessToken(pool: DbPool, env: GraphMailEnv): Promise<FreshTokenResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(
      `select refresh_token_enc, access_token_enc, access_token_expires_at from email_service_account for update`,
    );
    const row = rows[0];
    if (!row) {
      await client.query("rollback");
      return { ok: false, reason: "not_connected" };
    }

    // Cached access token still fresh enough → use it without touching the refresh token.
    if (row.access_token_enc && row.access_token_expires_at) {
      const expiresAt = new Date(row.access_token_expires_at).getTime();
      if (expiresAt > Date.now() + MIN_TOKEN_VALIDITY_MS) {
        try {
          const accessToken = decryptToken(row.access_token_enc, env.key);
          await client.query("commit");
          return { ok: true, accessToken };
        } catch {
          /* wrong key — fall through; the refresh path records the decrypt failure */
        }
      }
    }

    let refreshToken: string;
    try {
      refreshToken = decryptToken(row.refresh_token_enc, env.key);
    } catch {
      const error = "stored token cannot be decrypted (wrong EMAIL_TOKEN_ENC_KEY?)";
      await client.query(
        `update email_service_account set last_refresh_error = $1, last_refresh_at = now(), updated_at = now()`,
        [error],
      );
      await client.query("commit");
      return { ok: false, reason: "refresh_failed", error };
    }

    const f = env.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(`${env.loginBase ?? LOGIN_BASE}/${env.tenantId}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.clientId,
          client_secret: env.clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: GRAPH_MAIL_SCOPES,
        }),
        // Bound how long the row lock is held; a hung token endpoint must not stall the sweep.
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // A NETWORK-level failure (DNS/egress/TLS/timeout) is an expected outage, exactly like an
      // HTTP error: record it for the admin pill and return refresh_failed — never throw, or the
      // caller's sweep would freeze instead of degrading to SMTP/in-app (§12).
      const error = `token refresh failed: ${String((err as Error).message ?? err)}`.slice(0, 500);
      await client.query(
        `update email_service_account set last_refresh_error = $1, last_refresh_at = now(), updated_at = now()`,
        [error],
      );
      await client.query("commit");
      return { ok: false, reason: "refresh_failed", error };
    }
    if (!res.ok) {
      // Record the failure (pill surfacing) — never the tokens themselves.
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      const error = `token refresh failed: ${res.status}${detail ? ` ${detail}` : ""}`.slice(0, 500);
      await client.query(
        `update email_service_account set last_refresh_error = $1, last_refresh_at = now(), updated_at = now()`,
        [error],
      );
      await client.query("commit");
      return { ok: false, reason: "refresh_failed", error };
    }
    const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    const accessToken = json.access_token;
    const expiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000);
    const rotatedRefresh = json.refresh_token ?? refreshToken; // Entra rotates on use — re-store
    await client.query(
      `update email_service_account
          set access_token_enc = $1, access_token_expires_at = $2, refresh_token_enc = $3,
              last_refresh_at = now(), last_refresh_error = null, updated_at = now()`,
      [encryptToken(accessToken, env.key), expiresAt.toISOString(), encryptToken(rotatedRefresh, env.key)],
    );
    await client.query("commit");
    return { ok: true, accessToken };
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      /* connection-level failure — nothing to roll back */
    }
    throw err;
  } finally {
    client.release();
  }
}

// ── MIME + sendMail ────────────────────────────────────────────────────────────────────────

function b64wrap(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
}

/**
 * Build a multipart/alternative MIME message (plain-text part + wrapped HTML part, §12).
 * Graph's sendMail MIME format sets the From/Date/Message-ID from the authenticated mailbox.
 * The boundary cannot collide with the base64 bodies ("=" never precedes "_" in base64 lines).
 */
export function buildMimeMessage(m: { to: string; subject: string; text: string; html: string }): string {
  const boundary = "=_skilly_alt";
  return [
    `To: ${m.to.replace(/[\r\n]/g, "")}`,
    `Subject: =?UTF-8?B?${Buffer.from(m.subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64wrap(m.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64wrap(m.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

export class GraphSendError extends Error {
  constructor(
    public status: number,
    message: string,
    /** From the Retry-After header on 429s — the delivery sweep stops its batch (§12). */
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "GraphSendError";
  }
}

/** Send one email as the connected account via Graph `POST /me/sendMail` (MIME format). */
export async function sendGraphMail(
  env: GraphMailEnv,
  accessToken: string,
  msg: { to: string; subject: string; text: string; html: string },
): Promise<void> {
  const f = env.fetchImpl ?? fetch;
  const res = await f(`${env.graphBase ?? GRAPH_BASE}/me/sendMail`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "text/plain" },
    body: Buffer.from(buildMimeMessage(msg), "utf8").toString("base64"),
    // Don't let a hung Graph endpoint stall the (sequential) delivery sweep.
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 202) return;
  const retryAfter = Number(res.headers.get("retry-after") ?? "");
  throw new GraphSendError(res.status, `graph sendMail failed: ${res.status}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
}

// ── OAuth connect flow (web) ───────────────────────────────────────────────────────────────

/** PKCE pair for the authorization-code flow. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** The Entra authorize URL for "Set email service account". prompt=select_account so the
 *  admin can pick/enter the SERVICE mailbox instead of silently reusing their own session. */
export function buildAuthorizeUrl(
  env: Pick<GraphMailEnv, "tenantId" | "clientId" | "loginBase">,
  p: { redirectUri: string; state: string; codeChallenge: string },
): string {
  const qs = new URLSearchParams({
    client_id: env.clientId,
    response_type: "code",
    redirect_uri: p.redirectUri,
    response_mode: "query",
    scope: GRAPH_MAIL_SCOPES,
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${env.loginBase ?? LOGIN_BASE}/${env.tenantId}/oauth2/v2.0/authorize?${qs.toString()}`;
}

export interface AuthCodeTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  idToken: string;
}

/** Exchange the authorization code (confidential client + PKCE). Throws without leaking secrets. */
export async function exchangeAuthCode(
  env: GraphMailEnv,
  p: { code: string; redirectUri: string; codeVerifier: string },
): Promise<AuthCodeTokens> {
  const f = env.fetchImpl ?? fetch;
  const res = await f(`${env.loginBase ?? LOGIN_BASE}/${env.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      grant_type: "authorization_code",
      code: p.code,
      redirect_uri: p.redirectUri,
      code_verifier: p.codeVerifier,
      scope: GRAPH_MAIL_SCOPES,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`code exchange failed: ${res.status}${detail ? ` ${detail}` : ""}`);
  }
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number; id_token?: string };
  if (!json.refresh_token) throw new Error("Entra returned no refresh token — is offline_access consented?");
  if (!json.id_token) throw new Error("Entra returned no id_token");
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresInSec: json.expires_in ?? 3600, idToken: json.id_token };
}

export interface ServiceAccountClaims {
  oid: string;
  upn: string;
  name: string;
}

/** Decode the id_token payload. No signature check needed: the token came straight from the
 *  token endpoint over TLS to a confidential client (standard OIDC code-flow trust). */
export function parseIdTokenClaims(idToken: string): ServiceAccountClaims {
  const payload = idToken.split(".")[1];
  if (!payload) throw new Error("malformed id_token");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const oid = typeof claims.oid === "string" ? claims.oid : "";
  const upn =
    typeof claims.preferred_username === "string" ? claims.preferred_username : typeof claims.upn === "string" ? claims.upn : "";
  const name = typeof claims.name === "string" ? claims.name : upn;
  if (!oid || !upn) throw new Error("id_token missing oid/preferred_username");
  return { oid, upn, name };
}

/** Atomically store/replace the connected account (§12 re-connect replaces the single row;
 *  the caller audits `email.account_connected` with the returned replaced UPN). */
export async function saveConnectedAccount(
  db: DbClient,
  env: GraphMailEnv,
  p: { claims: ServiceAccountClaims; tokens: AuthCodeTokens; connectedByUserId: string | null },
): Promise<{ replacedUpn: string | null }> {
  const prev = await db.query(`select account_upn from email_service_account`);
  const replacedUpn: string | null = prev.rows[0]?.account_upn ?? null;
  await db.query(
    `insert into email_service_account
       (id, account_upn, account_display_name, account_oid, refresh_token_enc, access_token_enc,
        access_token_expires_at, connected_by_user_id, connected_at, last_refresh_at, last_refresh_error, updated_at)
     values (true, $1, $2, $3, $4, $5, $6, $7, now(), null, null, now())
     on conflict (id) do update
       set account_upn = excluded.account_upn,
           account_display_name = excluded.account_display_name,
           account_oid = excluded.account_oid,
           refresh_token_enc = excluded.refresh_token_enc,
           access_token_enc = excluded.access_token_enc,
           access_token_expires_at = excluded.access_token_expires_at,
           connected_by_user_id = excluded.connected_by_user_id,
           connected_at = now(),
           last_refresh_at = null,
           last_refresh_error = null,
           updated_at = now()`,
    [
      p.claims.upn,
      p.claims.name,
      p.claims.oid,
      encryptToken(p.tokens.refreshToken, env.key),
      encryptToken(p.tokens.accessToken, env.key),
      new Date(Date.now() + p.tokens.expiresInSec * 1000).toISOString(),
      p.connectedByUserId,
    ],
  );
  return { replacedUpn };
}

/** Disconnect: hard-delete the row (tokens destroyed). Returns the removed UPN for the audit. */
export async function disconnectEmailAccount(db: DbClient): Promise<string | null> {
  const { rows } = await db.query(`delete from email_service_account returning account_upn`);
  return rows[0]?.account_upn ?? null;
}
