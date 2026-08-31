// OAuth 2.1 authorization-server primitives for the §29 MCP server — the PURE half (no DB, no
// HTTP), shared by the web tier (which owns /oauth/authorize + DCR) and the worker (which owns
// /oauth/token, /oauth/revoke and the metadata documents).
//
// Posture, per SKILLY_SPEC.md §29/§22:
//   - authorization code + PKCE S256 ONLY (no implicit, no password, no client_credentials);
//   - public clients only (`token_endpoint_auth_method: "none"`) — MCP clients can't keep a secret,
//     PKCE is the compensating control;
//   - exact-match redirect URIs, with loopback treated port-agnostically (CLI/desktop clients bind
//     an ephemeral port) and NO wildcards anywhere;
//   - resource indicators (RFC 8707) validated, so a skilly token is useless at another resource;
//   - tokens are opaque random values stored as sha256 hashes and presented in the Authorization
//     header — never in a URL (stricter than the §23 install-token regime, not a carve-out).
import { createHash } from "node:crypto";
import { generateToken } from "./tokens.js";

/**
 * Strip trailing `/` without a regex.
 *
 * A trailing-slash strip written as an end-anchored `+` quantifier over the slash character is
 * polynomial-time on adversarial input (CodeQL js/polynomial-redos): it re-tries from every
 * position in a long run of slashes. These values come off the wire — a `resource` parameter, a
 * configured base URL — so the scan is not theoretical. Same treatment as `stripWrappingQuotes`
 * in external-tool.ts.
 */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* / */) end--;
  return s.slice(0, end);
}

/** The single opaque scope. §29: the boundary is the caller's own RBAC, not a string in a token. */
export const MCP_SCOPE = "mcp";

/** Authorization codes are single-use and very short-lived. */
export const AUTH_CODE_TTL_SECONDS = 60;

/** Only S256 — `plain` is not accepted (OAuth 2.1). */
export const PKCE_METHOD = "S256";

// ── Platform settings (§29). Bounds + coercion live here so web (writes) and worker (reads) agree ──

export const MCP_ACCESS_TTL_MIN_MINUTES = 5;
export const MCP_ACCESS_TTL_MAX_MINUTES = 1440;
export const MCP_ACCESS_TTL_DEFAULT_MINUTES = 60;

export const MCP_REFRESH_TTL_MIN_DAYS = 1;
export const MCP_REFRESH_TTL_MAX_DAYS = 365;
export const MCP_REFRESH_TTL_DEFAULT_DAYS = 90;

/** Inline (base64-in-tool-args) hosted-bundle cap — decoded bytes. Deliberately far below
 *  `max_bundle_bytes`: base64 inflates ~33% and no client carries a big bundle in a tool call. */
export const MCP_INLINE_UPLOAD_MIN_BYTES = 64 * 1024;
export const MCP_INLINE_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;
export const MCP_INLINE_UPLOAD_DEFAULT_BYTES = 2 * 1024 * 1024;

/** Per-file cap for a resource/`get_skill_file` read. Over it → an error naming `download`. */
export const MCP_RESOURCE_MIN_BYTES = 64 * 1024;
export const MCP_RESOURCE_MAX_BYTES = 16 * 1024 * 1024;
export const MCP_RESOURCE_DEFAULT_BYTES = 1024 * 1024;

/** Never-used client registrations are pruned after this long (bounds open-DCR growth, §22). */
export const MCP_CLIENT_PRUNE_DAYS = 7;

function coerceIntInRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/** The §29 on/off toggle. Ships **on**: anything but an explicit `false` is enabled. */
export function coerceMcpEnabled(value: unknown): boolean {
  return value === false ? false : true;
}

export function coerceMcpAccessTtlMinutes(value: unknown): number {
  return coerceIntInRange(value, MCP_ACCESS_TTL_MIN_MINUTES, MCP_ACCESS_TTL_MAX_MINUTES, MCP_ACCESS_TTL_DEFAULT_MINUTES);
}

export function coerceMcpRefreshTtlDays(value: unknown): number {
  return coerceIntInRange(value, MCP_REFRESH_TTL_MIN_DAYS, MCP_REFRESH_TTL_MAX_DAYS, MCP_REFRESH_TTL_DEFAULT_DAYS);
}

export function coerceMcpInlineUploadBytes(value: unknown): number {
  return coerceIntInRange(value, MCP_INLINE_UPLOAD_MIN_BYTES, MCP_INLINE_UPLOAD_MAX_BYTES, MCP_INLINE_UPLOAD_DEFAULT_BYTES);
}

export function coerceMcpResourceBytes(value: unknown): number {
  return coerceIntInRange(value, MCP_RESOURCE_MIN_BYTES, MCP_RESOURCE_MAX_BYTES, MCP_RESOURCE_DEFAULT_BYTES);
}

/** Validate an admin-entered value, throwing a message the admin panel can show verbatim. */
export function assertMcpAccessTtlMinutes(v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < MCP_ACCESS_TTL_MIN_MINUTES || (v as number) > MCP_ACCESS_TTL_MAX_MINUTES) {
    throw new Error(`MCP access-token lifetime must be a whole number of minutes between ${MCP_ACCESS_TTL_MIN_MINUTES} and ${MCP_ACCESS_TTL_MAX_MINUTES}`);
  }
  return v as number;
}

export function assertMcpRefreshTtlDays(v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < MCP_REFRESH_TTL_MIN_DAYS || (v as number) > MCP_REFRESH_TTL_MAX_DAYS) {
    throw new Error(`MCP refresh-token lifetime must be a whole number of days between ${MCP_REFRESH_TTL_MIN_DAYS} and ${MCP_REFRESH_TTL_MAX_DAYS}`);
  }
  return v as number;
}

export function assertMcpInlineUploadBytes(v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < MCP_INLINE_UPLOAD_MIN_BYTES || (v as number) > MCP_INLINE_UPLOAD_MAX_BYTES) {
    const mib = (n: number) => Math.round((n / (1024 * 1024)) * 10) / 10;
    throw new Error(`MCP inline upload limit must be a whole number of bytes between ${mib(MCP_INLINE_UPLOAD_MIN_BYTES)} and ${mib(MCP_INLINE_UPLOAD_MAX_BYTES)} MiB`);
  }
  return v as number;
}

export function assertMcpResourceBytes(v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < MCP_RESOURCE_MIN_BYTES || (v as number) > MCP_RESOURCE_MAX_BYTES) {
    const mib = (n: number) => Math.round((n / (1024 * 1024)) * 10) / 10;
    throw new Error(`MCP single-read limit must be a whole number of bytes between ${mib(MCP_RESOURCE_MIN_BYTES)} and ${mib(MCP_RESOURCE_MAX_BYTES)} MiB`);
  }
  return v as number;
}

// ── PKCE ──

/** The S256 code challenge for a verifier: base64url(sha256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

/** Does `verifier` satisfy the stored S256 `challenge`? Rejects malformed/short verifiers. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  // RFC 7636 §4.1: 43–128 chars from the unreserved set.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  if (!challenge) return false;
  return pkceChallenge(verifier) === challenge;
}

// ── Redirect URIs ──

/** Is this a loopback HTTP redirect (the only permitted non-https scheme)? */
function isLoopbackHttp(u: URL): boolean {
  return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1");
}

/**
 * Validate a redirect URI **at registration time**. Returns an error message, or null when the URI
 * is acceptable. Rules (§22): `https` anywhere; `http` only on loopback (any port); a custom app
 * scheme for native clients; never a wildcard, never a fragment, never `localhost` by name (it can
 * resolve off-host — `127.0.0.1` is the RFC 8252 recommendation).
 */
export function validateRedirectUri(raw: string): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return "redirect_uri must be a non-empty string";
  if (raw.includes("*")) return "redirect_uri must not contain a wildcard";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `redirect_uri is not a valid absolute URI: ${raw}`;
  }
  if (u.hash) return "redirect_uri must not contain a fragment";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:") {
    if (u.hostname === "localhost") return "use http://127.0.0.1 rather than localhost for a loopback redirect_uri";
    return isLoopbackHttp(u) ? null : "http redirect_uri is only allowed on loopback (127.0.0.1 / [::1])";
  }
  // A custom scheme for a native client (e.g. `myapp://oauth/callback`). Must be a real scheme
  // with a path/host — bare `myapp:` is not a usable redirect target.
  if (/^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) && raw.length > u.protocol.length + 1) return null;
  return `unsupported redirect_uri scheme: ${u.protocol}`;
}

/**
 * Exact-match a requested redirect URI against the client's registered set — with ONE deliberate
 * relaxation: for loopback HTTP, the **port is ignored** (RFC 8252 §7.3; an MCP CLI/desktop client
 * binds an ephemeral port at runtime and cannot register it). Everything else, including query
 * strings, must match byte-for-byte.
 */
export function redirectUriAllowed(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackHttp(req)) return false;
  return registered.some((r) => {
    let reg: URL;
    try {
      reg = new URL(r);
    } catch {
      return false;
    }
    return (
      isLoopbackHttp(reg) &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.search === req.search
    );
  });
}

// ── Resource indicators (RFC 8707) ──

/**
 * Is the `resource` the client asked for actually us? Compared on origin + path prefix, so both
 * `https://host/mcp` and `https://host` are accepted for a canonical `https://host/mcp`. A
 * mismatch must be refused (`invalid_target`) so a token minted for skilly can't be replayed at
 * another MCP server the client also talks to.
 */
export function resourceMatches(canonical: string, requested: string | null | undefined): boolean {
  if (!requested) return true; // omitted: the client gets a token bound to our canonical resource
  let want: URL;
  let mine: URL;
  try {
    want = new URL(requested);
    mine = new URL(canonical);
  } catch {
    return false;
  }
  if (want.origin.toLowerCase() !== mine.origin.toLowerCase()) return false;
  const wp = stripTrailingSlashes(want.pathname);
  const mp = stripTrailingSlashes(mine.pathname);
  return wp === "" || wp === mp || mp.startsWith(`${wp}/`);
}

// ── Token minting / lifetimes ──

/** A fresh opaque credential (43 base64url chars). Only its sha256 hash is ever stored. */
export function newOpaqueToken(): string {
  return generateToken();
}

export function accessTokenExpiry(ttlMinutes: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + ttlMinutes * 60_000);
}

export function refreshTokenExpiry(ttlDays: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + ttlDays * 86_400_000);
}

export function authCodeExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + AUTH_CODE_TTL_SECONDS * 1000);
}

// ── Dynamic Client Registration (RFC 7591) ──

export interface DcrRequest {
  client_name?: unknown;
  client_uri?: unknown;
  logo_uri?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  software_id?: unknown;
  software_version?: unknown;
  scope?: unknown;
}

export interface DcrClient {
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  redirectUris: string[];
  softwareId: string | null;
  softwareVersion: string | null;
}

const MAX_REDIRECT_URIS = 8;
const MAX_NAME_LEN = 120;

function optionalHttpUrl(v: unknown, field: string): { value: string | null } | { error: string } {
  if (v === undefined || v === null || v === "") return { value: null };
  if (typeof v !== "string") return { error: `${field} must be a string` };
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return { error: `${field} must be an http(s) URL` };
    return { value: v.slice(0, 500) };
  } catch {
    return { error: `${field} is not a valid URL` };
  }
}

/**
 * Validate + normalize a DCR request body. Registration is **open** (§29) — the gate is the human
 * consent leg, not this function — so this is about well-formedness and the redirect-URI rules,
 * not about deciding who may connect.
 */
export function validateDcr(body: DcrRequest): { ok: true; client: DcrClient } | { ok: false; error: string } {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    return { ok: false, error: "redirect_uris is required and must be a non-empty array" };
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    return { ok: false, error: `at most ${MAX_REDIRECT_URIS} redirect_uris` };
  }
  const redirectUris: string[] = [];
  for (const u of uris) {
    if (typeof u !== "string") return { ok: false, error: "each redirect_uri must be a string" };
    const err = validateRedirectUri(u);
    if (err) return { ok: false, error: err };
    if (!redirectUris.includes(u)) redirectUris.push(u);
  }

  // We only issue authorization codes to public clients. A client asking for anything else is
  // told plainly rather than silently downgraded.
  const authMethod = body.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== "none") {
    return { ok: false, error: "only public clients are supported (token_endpoint_auth_method must be \"none\")" };
  }
  const grants = body.grant_types;
  if (grants !== undefined) {
    if (!Array.isArray(grants)) return { ok: false, error: "grant_types must be an array" };
    const allowed = new Set(["authorization_code", "refresh_token"]);
    const bad = grants.find((g) => typeof g !== "string" || !allowed.has(g));
    if (bad !== undefined) return { ok: false, error: `unsupported grant_type: ${String(bad)}` };
  }
  const responses = body.response_types;
  if (responses !== undefined) {
    if (!Array.isArray(responses)) return { ok: false, error: "response_types must be an array" };
    const bad = responses.find((r) => r !== "code");
    if (bad !== undefined) return { ok: false, error: `unsupported response_type: ${String(bad)}` };
  }

  const clientUri = optionalHttpUrl(body.client_uri, "client_uri");
  if ("error" in clientUri) return { ok: false, error: clientUri.error };
  const logoUri = optionalHttpUrl(body.logo_uri, "logo_uri");
  if ("error" in logoUri) return { ok: false, error: logoUri.error };

  const rawName = typeof body.client_name === "string" ? body.client_name.trim() : "";
  const clientName = (rawName || "Unnamed MCP client").slice(0, MAX_NAME_LEN);

  return {
    ok: true,
    client: {
      clientName,
      clientUri: clientUri.value,
      logoUri: logoUri.value,
      redirectUris,
      softwareId: typeof body.software_id === "string" ? body.software_id.slice(0, 120) : null,
      softwareVersion: typeof body.software_version === "string" ? body.software_version.slice(0, 60) : null,
    },
  };
}

// ── Metadata documents ──

/** RFC 8414 authorization-server metadata for a given public base URL. */
export function authorizationServerMetadata(baseUrl: string): Record<string, unknown> {
  const base = stripTrailingSlashes(baseUrl);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: [PKCE_METHOD],
    token_endpoint_auth_methods_supported: ["none"],
    // RFC 8707 — we validate `resource` and bind tokens to it.
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${base}/mcp`,
  };
}

/** RFC 9728 protected-resource metadata — served BY the resource (the worker). */
export function protectedResourceMetadata(baseUrl: string): Record<string, unknown> {
  const base = stripTrailingSlashes(baseUrl);
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: `${base}/mcp`,
  };
}

/** The `WWW-Authenticate` value a 401 carries, so a client can discover how to authorize. */
export function wwwAuthenticate(baseUrl: string, error = "invalid_token"): string {
  const base = stripTrailingSlashes(baseUrl);
  return `Bearer error="${error}", resource_metadata="${base}/.well-known/oauth-protected-resource"`;
}
