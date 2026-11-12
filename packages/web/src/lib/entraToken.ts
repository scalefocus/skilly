// Entra access-token validation for the agent sync API (SKILLY_SPEC.md §69.2).
//
// The token AUTHENTICATES only. Nothing here reads `groups` or `roles`: membership comes from the
// SCIM-synced tables (invariant #1). The signature and the standard claims (`iss`, `aud`, `exp`,
// `nbf`) are checked by `jose`; only the Entra-specific claims (`tid`, `oid`, `scp`) are compared
// here. The token is never logged.
import { errors, importJWK, jwtVerify, type JWK } from "jose";

/** What the caller needs from a valid token — the inputs of the shared identity step (§69.3). */
export interface EntraIdentity {
  /** The Entra directory objectId — skilly's identity key. */
  oid: string;
  name: string | null;
  email: string | null;
  preferredUsername: string | null;
}

export type EntraTokenResult =
  | { ok: true; identity: EntraIdentity }
  /** `invalid_token` → 401, `insufficient_scope` → 403 (§69.9). */
  | { ok: false; error: "invalid_token" | "insufficient_scope" };

/** The tenant's signing keys could not be fetched and none are cached — skilly's failure (500), not the caller's. */
export class SigningKeysUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Entra signing keys unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SigningKeysUnavailableError";
  }
}

/** A well-formed token signed by a key the tenant does not publish. */
class UnknownKeyIdError extends Error {}

export interface EntraVerifierOptions {
  /** The tenant GUID — `ENTRA_TENANT_ID`, the setting the web sign-in reads. */
  tenantId: string;
  /** The `aud` a token must carry: the application (client) ID of skilly's app registration. */
  audience: string;
  /** The delegated scope that must be in `scp`. */
  requiredScope: string;
  /** Fetch the tenant's JWKS keys. Injected in tests; defaults to the Microsoft endpoint. */
  fetchJwks?: () => Promise<JWK[]>;
  now?: () => number;
}

export interface EntraTokenVerifier {
  verify(token: string): Promise<EntraTokenResult>;
}

/** A token with an unknown `kid` triggers a key refetch at most this often (§69.2). */
export const UNKNOWN_KID_REFETCH_MS = 60_000;
/** After a FAILED fetch the next attempt may come sooner, so one blip is not a minute of 500s. */
export const FAILED_FETCH_RETRY_MS = 5_000;
/** Cached keys are refreshed once they are this old, so a key Entra retired stops being accepted. */
export const KEY_MAX_AGE_MS = 24 * 60 * 60_000;
/** Clock skew allowed on `exp` / `nbf`, in seconds. */
export const CLOCK_SKEW_SECONDS = 60;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Entra access tokens are ~1–2.5 KB; anything far beyond that is not one. */
const MAX_TOKEN_CHARS = 16_384;

export function isGuid(v: unknown): v is string {
  return typeof v === "string" && GUID.test(v);
}

/** The tenant's v2 signing keys. */
export function entraJwksUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;
}

/** The only issuer accepted: the tenant's v2 endpoint (v1 tokens carry `sts.windows.net`). */
export function entraIssuer(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/v2.0`;
}

async function fetchTenantJwks(tenantId: string): Promise<JWK[]> {
  const res = await fetch(entraJwksUrl(tenantId), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) throw new Error("JWKS response has no keys");
  return body.keys as JWK[];
}

type VerifyKey = Awaited<ReturnType<typeof importJWK>>;

export function createEntraTokenVerifier(opts: EntraVerifierOptions): EntraTokenVerifier {
  const now = opts.now ?? Date.now;
  const fetchJwks = opts.fetchJwks ?? (() => fetchTenantJwks(opts.tenantId));
  const tenant = opts.tenantId.toLowerCase();
  const issuer = entraIssuer(opts.tenantId);

  // ── Signing-key cache ──────────────────────────────────────────────────────────────────────
  let keys = new Map<string, VerifyKey>();
  let loadedAt = 0; // 0 = never loaded
  let nextFetchAt = 0;
  let inflight: Promise<void> | null = null;

  function refresh(): Promise<void> {
    inflight ??= (async () => {
      try {
        const next = new Map<string, VerifyKey>();
        for (const jwk of await fetchJwks()) {
          if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || !jwk.kid) continue;
          if (jwk.use && jwk.use !== "sig") continue;
          try {
            next.set(jwk.kid, await importJWK(jwk, "RS256"));
          } catch {
            /* one malformed key must not hide the others */
          }
        }
        if (next.size === 0) throw new Error("JWKS has no usable RSA signing key");
        keys = next;
        loadedAt = now();
        nextFetchAt = loadedAt + UNKNOWN_KID_REFETCH_MS;
      } catch (e) {
        nextFetchAt = now() + FAILED_FETCH_RETRY_MS;
        throw e;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function keyFor(kid: string): Promise<VerifyKey | null> {
    const t = now();
    const stale = loadedAt !== 0 && t - loadedAt > KEY_MAX_AGE_MS;
    if ((!keys.has(kid) || stale) && t >= nextFetchAt) {
      try {
        await refresh();
      } catch (e) {
        // With keys in hand a failed refresh is survivable: keep validating against them.
        if (keys.size === 0) throw new SigningKeysUnavailableError(e);
      }
    }
    if (keys.size === 0) throw new SigningKeysUnavailableError("no signing keys loaded yet");
    return keys.get(kid) ?? null;
  }

  return {
    async verify(token: string): Promise<EntraTokenResult> {
      if (!token || token.length > MAX_TOKEN_CHARS) return { ok: false, error: "invalid_token" };
      let payload: Record<string, unknown>;
      try {
        const verified = await jwtVerify(
          token,
          async (header) => {
            if (typeof header.kid !== "string" || !header.kid) throw new UnknownKeyIdError("token has no kid");
            const key = await keyFor(header.kid);
            if (!key) throw new UnknownKeyIdError("unknown kid");
            return key;
          },
          {
            algorithms: ["RS256"], // `none`, HMAC and every other algorithm are refused before key lookup
            issuer,
            audience: opts.audience,
            clockTolerance: CLOCK_SKEW_SECONDS,
            currentDate: new Date(now()),
            requiredClaims: ["exp"],
          },
        );
        payload = verified.payload as Record<string, unknown>;
      } catch (e) {
        if (e instanceof SigningKeysUnavailableError) throw e;
        if (e instanceof UnknownKeyIdError || e instanceof errors.JOSEError) return { ok: false, error: "invalid_token" };
        throw e; // a bug, not a bad token — surfaces as 500 rather than a misleading 401
      }

      // Entra-specific claims. `aud` must be exactly the audience (a string, never a list).
      if (payload.aud !== opts.audience) return { ok: false, error: "invalid_token" };
      if (typeof payload.tid !== "string" || payload.tid.toLowerCase() !== tenant) return { ok: false, error: "invalid_token" };
      if (!isGuid(payload.oid)) return { ok: false, error: "invalid_token" };

      // Delegated tokens only: an app-only token has `roles`, never `scp`.
      const scopes = typeof payload.scp === "string" ? payload.scp.split(" ").filter(Boolean) : [];
      if (!scopes.includes(opts.requiredScope)) return { ok: false, error: "insufficient_scope" };

      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
      return {
        ok: true,
        identity: {
          oid: payload.oid, // as issued — the web sign-in matches it verbatim too
          name: str(payload.name),
          email: str(payload.email),
          preferredUsername: str(payload.preferred_username),
        },
      };
    },
  };
}
