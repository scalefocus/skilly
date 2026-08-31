import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pkceChallenge,
  verifyPkce,
  validateRedirectUri,
  redirectUriAllowed,
  resourceMatches,
  validateDcr,
  coerceMcpEnabled,
  coerceMcpAccessTtlMinutes,
  coerceMcpRefreshTtlDays,
  coerceMcpInlineUploadBytes,
  coerceMcpResourceBytes,
  assertMcpAccessTtlMinutes,
  authorizationServerMetadata,
  protectedResourceMetadata,
  wwwAuthenticate,
  MCP_ACCESS_TTL_DEFAULT_MINUTES,
  MCP_REFRESH_TTL_DEFAULT_DAYS,
  MCP_INLINE_UPLOAD_DEFAULT_BYTES,
  MCP_RESOURCE_DEFAULT_BYTES,
  accessTokenExpiry,
  refreshTokenExpiry,
  authCodeExpiry,
} from "./oauth.js";

const VERIFIER = "a".repeat(43);

test("PKCE S256 round-trips and rejects a wrong verifier", () => {
  const challenge = pkceChallenge(VERIFIER);
  assert.equal(verifyPkce(VERIFIER, challenge), true);
  assert.equal(verifyPkce("b".repeat(43), challenge), false);
});

test("PKCE rejects malformed verifiers (too short, illegal chars) and an empty challenge", () => {
  assert.equal(verifyPkce("short", pkceChallenge("short")), false);
  const bad = "a".repeat(42) + "!";
  assert.equal(verifyPkce(bad, pkceChallenge(bad)), false);
  assert.equal(verifyPkce(VERIFIER, ""), false);
});

test("redirect URI registration: https ok, loopback http ok, everything else refused", () => {
  assert.equal(validateRedirectUri("https://app.example.com/cb"), null);
  assert.equal(validateRedirectUri("http://127.0.0.1:8976/callback"), null);
  assert.equal(validateRedirectUri("http://[::1]:1234/cb"), null);
  assert.equal(validateRedirectUri("myapp://oauth/callback"), null);

  assert.match(String(validateRedirectUri("http://evil.example.com/cb")), /loopback/);
  assert.match(String(validateRedirectUri("http://localhost:3000/cb")), /127\.0\.0\.1/);
  assert.match(String(validateRedirectUri("https://*.example.com/cb")), /wildcard/);
  assert.match(String(validateRedirectUri("https://app.example.com/cb#frag")), /fragment/);
  assert.match(String(validateRedirectUri("not a url")), /valid absolute URI/);
  assert.match(String(validateRedirectUri("")), /non-empty/);
});

test("redirect matching is exact, except loopback ports", () => {
  const reg = ["https://app.example.com/cb", "http://127.0.0.1:1/callback"];
  assert.equal(redirectUriAllowed(reg, "https://app.example.com/cb"), true);
  // A different path, host or query on an https URI is NOT a match.
  assert.equal(redirectUriAllowed(reg, "https://app.example.com/cb2"), false);
  assert.equal(redirectUriAllowed(reg, "https://evil.example.com/cb"), false);
  assert.equal(redirectUriAllowed(reg, "https://app.example.com/cb?x=1"), false);
  // Loopback: any port, same path.
  assert.equal(redirectUriAllowed(reg, "http://127.0.0.1:54321/callback"), true);
  assert.equal(redirectUriAllowed(reg, "http://127.0.0.1:54321/other"), false);
  // A non-loopback http URI never rides the port relaxation.
  assert.equal(redirectUriAllowed(["http://127.0.0.1:1/cb"], "http://evil.example.com/cb"), false);
});

test("resource indicator: ours matches, another server's does not", () => {
  const canonical = "https://skilly.example.com/mcp";
  assert.equal(resourceMatches(canonical, undefined), true);
  assert.equal(resourceMatches(canonical, "https://skilly.example.com/mcp"), true);
  assert.equal(resourceMatches(canonical, "https://skilly.example.com"), true);
  assert.equal(resourceMatches(canonical, "https://SKILLY.example.com/mcp"), true);
  assert.equal(resourceMatches(canonical, "https://other.example.com/mcp"), false);
  assert.equal(resourceMatches(canonical, "https://skilly.example.com/other"), false);
  assert.equal(resourceMatches(canonical, "garbage"), false);
});

test("DCR accepts a normal public client and normalizes it", () => {
  const r = validateDcr({
    client_name: "  Claude Code  ",
    redirect_uris: ["http://127.0.0.1:8976/callback", "http://127.0.0.1:8976/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    software_id: "claude-code",
    software_version: "1.2.3",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.client.clientName, "Claude Code");
  assert.deepEqual(r.client.redirectUris, ["http://127.0.0.1:8976/callback"]);
  assert.equal(r.client.softwareId, "claude-code");
});

test("DCR refuses confidential clients, bad grants, missing/bad redirect URIs", () => {
  const noUris = validateDcr({ client_name: "x", redirect_uris: [] });
  assert.equal(noUris.ok, false);

  const secret = validateDcr({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" });
  assert.equal(secret.ok, false);
  if (!secret.ok) assert.match(secret.error, /public clients/);

  const badGrant = validateDcr({ redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] });
  assert.equal(badGrant.ok, false);
  if (!badGrant.ok) assert.match(badGrant.error, /client_credentials/);

  const badUri = validateDcr({ redirect_uris: ["http://evil.example/cb"] });
  assert.equal(badUri.ok, false);

  const tooMany = validateDcr({ redirect_uris: Array.from({ length: 9 }, (_, i) => `https://a.example/cb${i}`) });
  assert.equal(tooMany.ok, false);
});

test("DCR falls back to a placeholder name rather than failing", () => {
  const r = validateDcr({ redirect_uris: ["https://a.example/cb"] });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.client.clientName, "Unnamed MCP client");
});

test("settings coercion: MCP ships ON, out-of-range values fall back to defaults", () => {
  assert.equal(coerceMcpEnabled(undefined), true);
  assert.equal(coerceMcpEnabled(true), true);
  assert.equal(coerceMcpEnabled("nonsense"), true);
  assert.equal(coerceMcpEnabled(false), false);

  assert.equal(coerceMcpAccessTtlMinutes(30), 30);
  assert.equal(coerceMcpAccessTtlMinutes(0), MCP_ACCESS_TTL_DEFAULT_MINUTES);
  assert.equal(coerceMcpAccessTtlMinutes(99999), MCP_ACCESS_TTL_DEFAULT_MINUTES);
  assert.equal(coerceMcpAccessTtlMinutes(1.5), MCP_ACCESS_TTL_DEFAULT_MINUTES);

  assert.equal(coerceMcpRefreshTtlDays(30), 30);
  assert.equal(coerceMcpRefreshTtlDays(-1), MCP_REFRESH_TTL_DEFAULT_DAYS);

  assert.equal(coerceMcpInlineUploadBytes(1024 * 1024), 1024 * 1024);
  assert.equal(coerceMcpInlineUploadBytes(1), MCP_INLINE_UPLOAD_DEFAULT_BYTES);
  assert.equal(coerceMcpResourceBytes(1), MCP_RESOURCE_DEFAULT_BYTES);
});

test("admin-facing assertions throw a message worth showing", () => {
  assert.equal(assertMcpAccessTtlMinutes(60), 60);
  assert.throws(() => assertMcpAccessTtlMinutes(0), /between 5 and 1440/);
});

test("metadata documents point at the right split endpoints", () => {
  const md = authorizationServerMetadata("https://skilly.example.com/");
  assert.equal(md.issuer, "https://skilly.example.com");
  assert.equal(md.authorization_endpoint, "https://skilly.example.com/oauth/authorize");
  assert.equal(md.token_endpoint, "https://skilly.example.com/oauth/token");
  assert.deepEqual(md.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(md.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.deepEqual(md.token_endpoint_auth_methods_supported, ["none"]);

  const prm = protectedResourceMetadata("https://skilly.example.com");
  assert.equal(prm.resource, "https://skilly.example.com/mcp");
  assert.deepEqual(prm.authorization_servers, ["https://skilly.example.com"]);

  assert.match(wwwAuthenticate("https://skilly.example.com"), /resource_metadata="https:\/\/skilly\.example\.com\/\.well-known\/oauth-protected-resource"/);
});

test("expiries are computed from the given clock", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(accessTokenExpiry(60, now).toISOString(), "2026-01-01T01:00:00.000Z");
  assert.equal(refreshTokenExpiry(2, now).toISOString(), "2026-01-03T00:00:00.000Z");
  assert.equal(authCodeExpiry(now).toISOString(), "2026-01-01T00:01:00.000Z");
});
