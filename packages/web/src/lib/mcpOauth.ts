// The web tier's half of skilly's OAuth 2.1 authorization server (§29): open Dynamic Client
// Registration and the authorize + consent leg. The token/revoke endpoints and the MCP endpoint
// itself live on the WORKER — see §29 "Shape & placement".
//
// The authorize leg has to be here for one reason: it needs the Auth.js/Entra session, which only
// this package has. A signed-in user consents in one click; a signed-out one is sent through the
// normal sign-in first and comes back to the same authorize URL.
//
// All policy (PKCE, redirect matching, resource indicators, TTLs) comes from @skilly/shared/oauth
// so the two halves cannot drift.
import { randomUUID } from "node:crypto";
import { pool } from "./db";
import { appendAudit } from "./audit";
import {
  MCP_SCOPE,
  authCodeExpiry,
  generateToken,
  hashToken,
  newOpaqueToken,
  redirectUriAllowed,
  resourceMatches,
  validateDcr,
  type DcrClient,
  type DcrRequest,
} from "@skilly/shared";

/** The registry's public base URL (no trailing slash) — the issuer and the resource root. */
export function publicBaseUrl(): string {
  const raw =
    process.env.PUBLIC_BASE_URL ?? process.env.SKILLY_REGISTRY_URL ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

export function canonicalResource(): string {
  return `${publicBaseUrl()}/mcp`;
}

export interface RegisteredClient {
  id: string;
  clientId: string;
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  redirectUris: string[];
  blocked: boolean;
}

/**
 * Register a client (RFC 7591). Registration is OPEN by design: a `client_id` grants nothing until
 * a human signs in with Entra and approves, so the consent screen — not an admin allowlist — is the
 * gate. Growth is bounded by the caller's rate limit, the worker's 7-day prune of never-used
 * registrations, and the admin block list.
 */
export async function registerClient(
  body: DcrRequest,
  registeredIp: string | null,
): Promise<{ ok: true; client: RegisteredClient } | { ok: false; error: string }> {
  const parsed = validateDcr(body);
  if (!parsed.ok) return parsed;
  return { ok: true, client: await insertClient(parsed.client, registeredIp) };
}

async function insertClient(c: DcrClient, registeredIp: string | null): Promise<RegisteredClient> {
  // A public, random client_id — it is an identifier, not a secret, but it should not be guessable
  // (a guessable one lets someone impersonate a client on the consent screen).
  const clientId = `mcp_${generateToken(18)}`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into oauth_clients (client_id, client_name, client_uri, logo_uri, redirect_uris, software_id, software_version, registered_ip)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [clientId, c.clientName, c.clientUri, c.logoUri, c.redirectUris, c.softwareId, c.softwareVersion, registeredIp],
  );
  return {
    id: rows[0]!.id,
    clientId,
    clientName: c.clientName,
    clientUri: c.clientUri,
    logoUri: c.logoUri,
    redirectUris: c.redirectUris,
    blocked: false,
  };
}

export async function findClient(clientId: string): Promise<RegisteredClient | null> {
  const { rows } = await pool.query<{
    id: string;
    client_id: string;
    client_name: string;
    client_uri: string | null;
    logo_uri: string | null;
    redirect_uris: string[];
    blocked_at: string | null;
  }>(
    `select id, client_id, client_name, client_uri, logo_uri, redirect_uris, blocked_at
       from oauth_clients where client_id = $1`,
    [clientId],
  );
  const r = rows[0];
  return r
    ? {
        id: r.id,
        clientId: r.client_id,
        clientName: r.client_name,
        clientUri: r.client_uri,
        logoUri: r.logo_uri,
        redirectUris: r.redirect_uris ?? [],
        blocked: r.blocked_at != null,
      }
    : null;
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string | null;
  scope: string | null;
}

export type AuthorizeCheck =
  | { ok: true; client: RegisteredClient; request: AuthorizeRequest }
  /** Safe to redirect the error back to the client (the redirect_uri is verified). */
  | { ok: false; redirect: string }
  /** NOT safe to redirect — show the user an error page instead (RFC 6749 §4.1.2.1). */
  | { ok: false; error: string };

/**
 * Validate an authorization request. When the client or redirect_uri can't be verified we must NOT
 * redirect (that would make skilly an open redirector); we render an error instead. Once the
 * redirect is verified, protocol errors go back to the client the normal way.
 */
export async function checkAuthorizeRequest(params: URLSearchParams): Promise<AuthorizeCheck> {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!clientId) return { ok: false, error: "missing client_id" };
  const client = await findClient(clientId);
  if (!client) return { ok: false, error: "unknown client_id — the client must register first" };
  if (client.blocked) return { ok: false, error: "this client has been blocked by an administrator" };
  if (!redirectUri) return { ok: false, error: "missing redirect_uri" };
  if (!redirectUriAllowed(client.redirectUris, redirectUri)) {
    return { ok: false, error: "redirect_uri does not match this client's registration" };
  }

  const state = params.get("state");
  const err = (code: string, description: string): AuthorizeCheck => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", code);
    u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    return { ok: false, redirect: u.toString() };
  };

  if ((params.get("response_type") ?? "") !== "code") return err("unsupported_response_type", "only response_type=code is supported");
  const codeChallenge = params.get("code_challenge") ?? "";
  const method = params.get("code_challenge_method") ?? "";
  // PKCE is mandatory (OAuth 2.1) and only S256 is accepted — `plain` offers no protection.
  if (!codeChallenge) return err("invalid_request", "PKCE is required: send code_challenge");
  if (method !== "S256") return err("invalid_request", "code_challenge_method must be S256");
  const resource = params.get("resource");
  if (resource && !resourceMatches(canonicalResource(), resource)) {
    return err("invalid_target", "this authorization server only issues tokens for its own MCP endpoint");
  }
  const scope = params.get("scope");
  if (scope && !scope.split(/\s+/).every((x) => x === MCP_SCOPE || x === "")) {
    return err("invalid_scope", `the only supported scope is "${MCP_SCOPE}"`);
  }

  return {
    ok: true,
    client,
    request: { clientId, redirectUri, state, codeChallenge, codeChallengeMethod: method, resource, scope },
  };
}

/**
 * Record the user's consent and mint a single-use authorization code. One LIVE grant per
 * (user, client): re-consenting refreshes the existing grant rather than piling rows up.
 */
export async function approveAuthorization(
  userId: string,
  client: RegisteredClient,
  request: AuthorizeRequest,
): Promise<{ redirect: string }> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const existing = await db.query<{ id: string }>(
      `select id from oauth_grants where user_id = $1 and client_id = $2 and revoked_at is null`,
      [userId, client.id],
    );
    let grantId = existing.rows[0]?.id ?? null;
    if (!grantId) {
      const ins = await db.query<{ id: string }>(
        `insert into oauth_grants (user_id, client_id, scope) values ($1,$2,$3) returning id`,
        [userId, client.id, MCP_SCOPE],
      );
      grantId = ins.rows[0]!.id;
      await appendAudit(db, {
        actorUserId: userId,
        action: "mcp.grant_created",
        targetType: "oauth_grant",
        targetId: grantId,
        after: { client: client.clientName, clientId: client.clientId },
      });
    }
    const code = newOpaqueToken();
    await db.query(
      `insert into oauth_tokens (grant_id, kind, hashed_token, expires_at, code_challenge, redirect_uri, resource)
       values ($1, 'code', $2, $3, $4, $5, $6)`,
      [grantId, hashToken(code), authCodeExpiry(), request.codeChallenge, request.redirectUri, request.resource ?? canonicalResource()],
    );
    await db.query(`update oauth_clients set last_used_at = now() where id = $1`, [client.id]);
    await db.query("commit");

    const u = new URL(request.redirectUri);
    u.searchParams.set("code", code);
    if (request.state) u.searchParams.set("state", request.state);
    // RFC 9207: let the client bind the response to this issuer.
    u.searchParams.set("iss", publicBaseUrl());
    return { redirect: u.toString() };
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    db.release();
  }
}

/** The user declined on the consent screen — a normal OAuth outcome, not an error page. */
export function denyAuthorization(request: AuthorizeRequest): { redirect: string } {
  const u = new URL(request.redirectUri);
  u.searchParams.set("error", "access_denied");
  u.searchParams.set("error_description", "the user declined this connection");
  if (request.state) u.searchParams.set("state", request.state);
  return { redirect: u.toString() };
}

// ── Consent-request handoff ─────────────────────────────────────────────────────────────────────
// The consent screen is a form POST, and re-parsing the query string on submit would mean
// re-validating everything and trusting hidden fields. Instead the validated request is stashed
// server-side under an opaque id and the form carries only that id.

const PENDING_TTL_MS = 10 * 60 * 1000;
const pending = new Map<string, { at: number; clientId: string; request: AuthorizeRequest; userId: string }>();

export function stashAuthorizeRequest(userId: string, client: RegisteredClient, request: AuthorizeRequest): string {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > PENDING_TTL_MS) pending.delete(k);
  const id = randomUUID();
  pending.set(id, { at: now, clientId: client.clientId, request, userId });
  return id;
}

export function takeAuthorizeRequest(
  id: string,
  userId: string,
): { clientId: string; request: AuthorizeRequest } | null {
  const entry = pending.get(id);
  if (!entry) return null;
  pending.delete(id);
  if (Date.now() - entry.at > PENDING_TTL_MS) return null;
  // The consent must be given by the SAME user the request was stashed for.
  if (entry.userId !== userId) return null;
  return { clientId: entry.clientId, request: entry.request };
}

// ── Connections (the /mcp page) ─────────────────────────────────────────────────────────────────

export interface ConnectionView {
  grantId: string;
  clientName: string;
  clientUri: string | null;
  authorizedAt: string;
  lastUsedAt: string | null;
  blocked: boolean;
}

/** The caller's own live grants — one row per connected client. */
export async function listConnections(userId: string): Promise<ConnectionView[]> {
  const { rows } = await pool.query<{
    id: string;
    client_name: string;
    client_uri: string | null;
    created_at: string;
    last_used_at: string | null;
    blocked_at: string | null;
  }>(
    `select g.id, c.client_name, c.client_uri, g.created_at, g.last_used_at, c.blocked_at
       from oauth_grants g join oauth_clients c on c.id = g.client_id
      where g.user_id = $1 and g.revoked_at is null
      order by coalesce(g.last_used_at, g.created_at) desc`,
    [userId],
  );
  return rows.map((r) => ({
    grantId: r.id,
    clientName: r.client_name,
    clientUri: r.client_uri,
    authorizedAt: r.created_at,
    lastUsedAt: r.last_used_at,
    blocked: r.blocked_at != null,
  }));
}

/**
 * Revoke one connection: the grant and every token under it. Immediate — the access token stops
 * working on the next request, not at its expiry. Does NOT touch install tokens the client minted:
 * those are ordinary §23 installations, listed and revoked on /installed.
 */
export async function revokeConnection(
  userId: string,
  grantId: string,
  actorUserId: string,
  opts: { asAdmin?: boolean } = {},
): Promise<boolean> {
  const owner = opts.asAdmin ? null : userId;
  const { rows } = await pool.query<{ id: string; client_name: string; user_id: string }>(
    `update oauth_grants g
        set revoked_at = now(), revoked_by_user_id = $3
      where g.id = $1 and g.revoked_at is null and ($2::uuid is null or g.user_id = $2)
      returning g.id, g.user_id, (select client_name from oauth_clients c where c.id = g.client_id) as client_name`,
    [grantId, owner, actorUserId],
  );
  const row = rows[0];
  if (!row) return false;
  await pool.query(`update oauth_tokens set expires_at = now() where grant_id = $1 and expires_at > now()`, [grantId]);
  await appendAudit(pool, {
    actorUserId,
    action: "mcp.grant_revoked",
    targetType: "oauth_grant",
    targetId: grantId,
    after: { client: row.client_name, owner: row.user_id, byAdmin: opts.asAdmin === true },
  });
  return true;
}

/**
 * Revoke every grant a user holds. Called by deactivation and GDPR erasure (§4/§5): unlike a §23
 * install token — a durable artifact a reinstated user may want back — a live delegation to a
 * third-party client must not survive the user leaving.
 */
export async function revokeAllUserGrants(db: typeof pool, userId: string): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `update oauth_grants set revoked_at = now() where user_id = $1 and revoked_at is null returning id`,
    [userId],
  );
  if (rows.length) {
    await db.query(
      `update oauth_tokens set expires_at = now()
        where grant_id = any($1::uuid[]) and expires_at > now()`,
      [rows.map((r) => r.id)],
    );
  }
  return rows.length;
}

// ── Administration (§29 card) ───────────────────────────────────────────────────────────────────

export interface AdminClientView {
  id: string;
  clientId: string;
  clientName: string;
  clientUri: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  blocked: boolean;
  liveGrants: number;
}

export async function adminMcpStatus(): Promise<{ liveGrants: number; clients: AdminClientView[] }> {
  const [grants, clients] = await Promise.all([
    pool.query<{ n: string }>(`select count(*)::text as n from oauth_grants where revoked_at is null`),
    pool.query<{
      id: string;
      client_id: string;
      client_name: string;
      client_uri: string | null;
      created_at: string;
      last_used_at: string | null;
      blocked_at: string | null;
      live_grants: string;
    }>(
      `select c.id, c.client_id, c.client_name, c.client_uri, c.created_at, c.last_used_at, c.blocked_at,
              (select count(*)::text from oauth_grants g where g.client_id = c.id and g.revoked_at is null) as live_grants
         from oauth_clients c
        order by coalesce(c.last_used_at, c.created_at) desc
        limit 200`,
    ),
  ]);
  return {
    liveGrants: Number(grants.rows[0]?.n ?? 0),
    clients: clients.rows.map((c) => ({
      id: c.id,
      clientId: c.client_id,
      clientName: c.client_name,
      clientUri: c.client_uri,
      createdAt: c.created_at,
      lastUsedAt: c.last_used_at,
      blocked: c.blocked_at != null,
      liveGrants: Number(c.live_grants),
    })),
  };
}

/**
 * Block or unblock a client platform-wide. Blocking refuses its token exchanges and every MCP
 * request under it, without revoking anyone's grant — so unblocking restores service without
 * re-onboarding the org. This is the incident control; there is deliberately no org-wide
 * "revoke all" button (§29).
 */
export async function setClientBlocked(clientDbId: string, blocked: boolean, actorUserId: string): Promise<boolean> {
  const { rows } = await pool.query<{ client_name: string }>(
    `update oauth_clients set blocked_at = case when $2 then now() else null end
      where id = $1 returning client_name`,
    [clientDbId, blocked],
  );
  if (!rows[0]) return false;
  await appendAudit(pool, {
    actorUserId,
    action: blocked ? "mcp.client_blocked" : "mcp.client_unblocked",
    targetType: "oauth_client",
    targetId: clientDbId,
    after: { client: rows[0].client_name },
  });
  return true;
}
