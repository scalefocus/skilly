// The worker's half of skilly's OAuth 2.1 authorization server (§29): the token endpoint, the
// revocation endpoint and both metadata documents. The BROWSER half (/oauth/authorize + consent
// and open Dynamic Client Registration) lives in `packages/web`, because the authorize leg needs
// the Auth.js/Entra session that only web has — see §29 "Shape & placement".
//
// Everything policy-shaped (PKCE verification, redirect matching, resource indicators, TTLs,
// metadata) comes from `@skilly/shared/oauth` so the two halves can't drift.
import { Router, type Request, type Response } from "express";
import express from "express";
import type { Pool } from "pg";
import {
  MCP_SCOPE,
  accessTokenExpiry,
  authorizationServerMetadata,
  hashToken,
  newOpaqueToken,
  protectedResourceMetadata,
  refreshTokenExpiry,
  resourceMatches,
  verifyPkce,
} from "@skilly/shared";
import { getMcpSettings } from "./settings.js";
import { logMcpEvent } from "./systemLog.js";
import { publicBaseUrl, canonicalResource } from "./url.js";
import { M } from "../metrics.js";

/** OAuth error responses are a fixed shape (RFC 6749 §5.2) — never leak detail into `error`. */
function oauthError(res: Response, status: number, error: string, description?: string): void {
  res.status(status).json(description ? { error, error_description: description } : { error });
}

interface IssuedTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/**
 * Mint a fresh access + refresh pair for a grant. Refresh tokens ROTATE on every use, so this is
 * called both at code exchange and at refresh; `rotatedFromId` records the lineage that makes
 * reuse detection possible.
 */
async function issueTokens(
  pool: Pool,
  grantId: string,
  ttl: { accessTtlMinutes: number; refreshTtlDays: number },
  rotatedFromId: string | null,
): Promise<IssuedTokens> {
  const access = newOpaqueToken();
  const refresh = newOpaqueToken();
  const accessExp = accessTokenExpiry(ttl.accessTtlMinutes);
  const refreshExp = refreshTokenExpiry(ttl.refreshTtlDays);
  await pool.query(
    `insert into oauth_tokens (grant_id, kind, hashed_token, expires_at, rotated_from_id)
     values ($1, 'access', $2, $3, null), ($1, 'refresh', $4, $5, $6)`,
    [grantId, hashToken(access), accessExp, hashToken(refresh), refreshExp, rotatedFromId],
  );
  M.mcpTokensIssued.inc();
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.max(1, Math.floor((accessExp.getTime() - Date.now()) / 1000)),
    refresh_token: refresh,
    scope: MCP_SCOPE,
  };
}

/** Revoke a whole grant and every token under it (the refresh-reuse and user-revoke response). */
async function revokeGrant(pool: Pool, grantId: string, revokedByUserId: string | null): Promise<void> {
  await pool.query(
    `update oauth_grants set revoked_at = now(), revoked_by_user_id = coalesce($2, revoked_by_user_id)
      where id = $1 and revoked_at is null`,
    [grantId, revokedByUserId],
  );
  // Expire the live credentials immediately rather than waiting for the sweep, so a revoked grant
  // stops working on the very next request even if `revoked_at` were somehow missed.
  await pool.query(`update oauth_tokens set expires_at = now() where grant_id = $1 and expires_at > now()`, [grantId]);
}

async function handleAuthorizationCode(pool: Pool, req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const code = typeof body.code === "string" ? body.code : "";
  const verifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
  const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
  const clientId = typeof body.client_id === "string" ? body.client_id : "";
  const resource = typeof body.resource === "string" ? body.resource : null;

  if (!code || !verifier || !clientId) {
    return oauthError(res, 400, "invalid_request", "code, code_verifier and client_id are required");
  }

  const { rows } = await pool.query<{
    token_id: string;
    grant_id: string;
    code_challenge: string | null;
    stored_redirect: string | null;
    stored_resource: string | null;
    used_at: string | null;
    expired: boolean;
    client_id_public: string;
    client_blocked: boolean;
    grant_revoked: boolean;
  }>(
    `select t.id as token_id, t.grant_id, t.code_challenge, t.redirect_uri as stored_redirect,
            t.resource as stored_resource, t.used_at, (t.expires_at <= now()) as expired,
            c.client_id as client_id_public, (c.blocked_at is not null) as client_blocked,
            (g.revoked_at is not null) as grant_revoked
       from oauth_tokens t
       join oauth_grants g  on g.id = t.grant_id
       join oauth_clients c on c.id = g.client_id
      where t.kind = 'code' and t.hashed_token = $1`,
    [hashToken(code)],
  );
  const row = rows[0];
  if (!row) return oauthError(res, 400, "invalid_grant", "unknown or already-consumed authorization code");

  // A REPLAYED code is treated as a compromise signal, exactly like a replayed refresh token:
  // the grant goes down. (RFC 6749 §10.5 / OAuth 2.1 §4.1.3.)
  if (row.used_at) {
    await revokeGrant(pool, row.grant_id, null);
    await logMcpEvent(pool, { errorCode: "mcp_refresh_reuse_detected", status: 400, route: "/oauth/token", path: "/oauth/token", message: "authorization code replayed — grant revoked" });
    return oauthError(res, 400, "invalid_grant", "authorization code already used");
  }
  if (row.expired) return oauthError(res, 400, "invalid_grant", "authorization code expired");
  if (row.grant_revoked) return oauthError(res, 400, "invalid_grant", "grant revoked");
  if (row.client_blocked) {
    await logMcpEvent(pool, { errorCode: "mcp_client_blocked", status: 400, route: "/oauth/token", path: "/oauth/token", message: "blocked client attempted a code exchange" });
    return oauthError(res, 400, "invalid_client", "this client has been blocked by an administrator");
  }
  if (row.client_id_public !== clientId) return oauthError(res, 400, "invalid_grant", "client_id does not match the authorization code");
  // The redirect_uri must match the one the code was issued for, byte-for-byte.
  if ((row.stored_redirect ?? "") !== redirectUri) return oauthError(res, 400, "invalid_grant", "redirect_uri does not match the authorization request");
  if (!row.code_challenge || !verifyPkce(verifier, row.code_challenge)) {
    return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
  }
  // RFC 8707: if the client names a resource now, it must be the one the code was bound to.
  if (resource && !resourceMatches(canonicalResource(), resource)) {
    return oauthError(res, 400, "invalid_target", "this token is only valid for this registry's MCP endpoint");
  }

  // Consume the code (single-use) — conditional so two concurrent exchanges can't both win.
  const consumed = await pool.query(`update oauth_tokens set used_at = now() where id = $1 and used_at is null`, [row.token_id]);
  if ((consumed.rowCount ?? 0) === 0) return oauthError(res, 400, "invalid_grant", "authorization code already used");

  const settings = await getMcpSettings(pool);
  res.setHeader("Cache-Control", "no-store");
  res.json(await issueTokens(pool, row.grant_id, settings, null));
}

async function handleRefresh(pool: Pool, req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const refresh = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const resource = typeof body.resource === "string" ? body.resource : null;
  if (!refresh) return oauthError(res, 400, "invalid_request", "refresh_token is required");

  const { rows } = await pool.query<{
    token_id: string;
    grant_id: string;
    used_at: string | null;
    expired: boolean;
    grant_revoked: boolean;
    client_blocked: boolean;
    user_active: boolean;
  }>(
    `select t.id as token_id, t.grant_id, t.used_at, (t.expires_at <= now()) as expired,
            (g.revoked_at is not null) as grant_revoked,
            (c.blocked_at is not null) as client_blocked,
            (u.status = 'active') as user_active
       from oauth_tokens t
       join oauth_grants g  on g.id = t.grant_id
       join oauth_clients c on c.id = g.client_id
       join users u         on u.id = g.user_id
      where t.kind = 'refresh' and t.hashed_token = $1`,
    [hashToken(refresh)],
  );
  const row = rows[0];
  if (!row) return oauthError(res, 400, "invalid_grant", "unknown refresh token");

  // REUSE DETECTION (§22): an already-rotated refresh token means either a race or a stolen
  // credential. We cannot tell them apart, so we assume the worse and take the whole grant down.
  if (row.used_at) {
    await revokeGrant(pool, row.grant_id, null);
    M.mcpRefreshReuse.inc();
    await logMcpEvent(pool, {
      errorCode: "mcp_refresh_reuse_detected",
      status: 400,
      route: "/oauth/token",
      path: "/oauth/token",
      message: "rotated refresh token replayed — grant revoked",
    });
    return oauthError(res, 400, "invalid_grant", "refresh token already used — the connection has been revoked, please reconnect");
  }
  if (row.expired) return oauthError(res, 400, "invalid_grant", "refresh token expired");
  if (row.grant_revoked) return oauthError(res, 400, "invalid_grant", "grant revoked");
  if (!row.user_active) {
    await logMcpEvent(pool, { errorCode: "mcp_owner_inactive", status: 400, route: "/oauth/token", path: "/oauth/token", message: "refresh attempted for an inactive user" });
    return oauthError(res, 400, "invalid_grant", "grant revoked");
  }
  if (row.client_blocked) {
    await logMcpEvent(pool, { errorCode: "mcp_client_blocked", status: 400, route: "/oauth/token", path: "/oauth/token", message: "blocked client attempted a refresh" });
    return oauthError(res, 400, "invalid_client", "this client has been blocked by an administrator");
  }
  if (resource && !resourceMatches(canonicalResource(), resource)) {
    return oauthError(res, 400, "invalid_target", "this token is only valid for this registry's MCP endpoint");
  }

  const consumed = await pool.query(`update oauth_tokens set used_at = now() where id = $1 and used_at is null`, [row.token_id]);
  if ((consumed.rowCount ?? 0) === 0) return oauthError(res, 400, "invalid_grant", "refresh token already used");

  const settings = await getMcpSettings(pool);
  res.setHeader("Cache-Control", "no-store");
  res.json(await issueTokens(pool, row.grant_id, settings, row.token_id));
}

/**
 * The worker-side OAuth router. Mounted BEFORE the git handler is irrelevant (paths don't
 * overlap), but it must be mounted with its own body parser: the git smart server needs the raw
 * request stream, so the worker deliberately has no app-wide parser.
 */
export function mcpOAuthRouter(pool: Pool): Router {
  const r = Router();
  const form = express.urlencoded({ extended: false, limit: "16kb" });
  const json = express.json({ limit: "16kb" });

  // ── Metadata (RFC 8414 + RFC 9728). Public by design: a client must be able to discover how to
  // authorize BEFORE it has any credential. Served even when MCP is disabled would be misleading,
  // so the toggle gates these too — a disabled registry advertises nothing.
  const metadata = (build: (base: string) => Record<string, unknown>) => async (_req: Request, res: Response) => {
    const { enabled } = await getMcpSettings(pool);
    if (!enabled) {
      res.status(503).json({ error: "MCP is disabled on this registry" });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(build(publicBaseUrl()));
  };
  r.get("/.well-known/oauth-authorization-server", metadata(authorizationServerMetadata));
  r.get("/.well-known/oauth-protected-resource", metadata(protectedResourceMetadata));
  // Some clients probe the resource-scoped form (`/.well-known/oauth-protected-resource/mcp`).
  r.get("/.well-known/oauth-protected-resource/mcp", metadata(protectedResourceMetadata));

  r.post("/oauth/token", form, json, async (req, res) => {
    const { enabled } = await getMcpSettings(pool);
    if (!enabled) {
      await logMcpEvent(pool, { errorCode: "mcp_disabled", status: 503, route: "/oauth/token", path: "/oauth/token", message: "token exchange refused — MCP disabled" });
      return oauthError(res, 503, "temporarily_unavailable", "MCP is disabled on this registry");
    }
    const grantType = (req.body as Record<string, unknown> | undefined)?.grant_type;
    try {
      if (grantType === "authorization_code") return await handleAuthorizationCode(pool, req, res);
      if (grantType === "refresh_token") return await handleRefresh(pool, req, res);
      return oauthError(res, 400, "unsupported_grant_type", "only authorization_code and refresh_token are supported");
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "oauth token endpoint failed", err: String(e instanceof Error ? e.message : e) }));
      return oauthError(res, 500, "server_error");
    }
  });

  // RFC 7009. A public client presents the token it holds; we revoke the whole grant behind it,
  // because for a public client "revoke my token" always means "disconnect me".
  r.post("/oauth/revoke", form, json, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = typeof body.token === "string" ? body.token : "";
    // RFC 7009 §2.2: always 200, even for an unknown token — no probing oracle.
    if (raw) {
      try {
        const { rows } = await pool.query<{ grant_id: string }>(
          `select grant_id from oauth_tokens where hashed_token = $1 and kind in ('access', 'refresh')`,
          [hashToken(raw)],
        );
        if (rows[0]) await revokeGrant(pool, rows[0].grant_id, null);
      } catch (e) {
        console.error(JSON.stringify({ level: "error", msg: "oauth revoke failed", err: String(e instanceof Error ? e.message : e) }));
      }
    }
    res.status(200).end();
  });

  return r;
}

/**
 * Housekeeping (leader-only, §29): drop expired codes and dead tokens, and prune client
 * registrations that never produced a grant — the bound on open DCR growth. Rotation lineage is
 * kept for the refresh window so reuse detection still works, then pruned with the rest.
 */
export async function mcpHousekeeping(pool: Pool): Promise<{ tokens: number; clients: number }> {
  const settings = await getMcpSettings(pool);
  const tokens = await pool.query(
    `delete from oauth_tokens
      where (kind = 'code' and expires_at < now() - interval '1 hour')
         or (kind = 'access' and expires_at < now() - interval '1 day')
         or (kind = 'refresh' and expires_at < now() - ($1 || ' days')::interval)`,
    [String(settings.refreshTtlDays)],
  );
  const clients = await pool.query(
    `delete from oauth_clients
      where last_used_at is null
        and created_at < now() - interval '7 days'
        and not exists (select 1 from oauth_grants g where g.client_id = oauth_clients.id)`,
  );
  return { tokens: tokens.rowCount ?? 0, clients: clients.rowCount ?? 0 };
}
