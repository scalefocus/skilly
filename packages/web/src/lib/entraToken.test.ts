// Entra access-token validation (SKILLY_SPEC.md §69.2, §69.13). A locally generated RSA key and an
// in-memory JWKS — no call to Microsoft.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import {
  CLOCK_SKEW_SECONDS,
  FAILED_FETCH_RETRY_MS,
  SigningKeysUnavailableError,
  UNKNOWN_KID_REFETCH_MS,
  createEntraTokenVerifier,
  entraIssuer,
  entraJwksUrl,
} from "./entraToken";

const TENANT = "11111111-2222-3333-4444-555555555555";
const AUDIENCE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OID = "99999999-8888-7777-6666-555555555555";
const SCOPE = "Skills.Sync";
const T0 = Date.UTC(2026, 10, 12, 8, 0, 0); // fixed "now" (ms)

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
interface Signer { kid: string; pair: KeyPair; jwk: JWK }

async function signer(kid: string): Promise<Signer> {
  const pair = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(pair.publicKey)), kid, use: "sig", alg: "RS256" };
  return { kid, pair, jwk };
}

/** A token as Entra v2 would issue it for skilly's API; `over` replaces or (undefined) drops claims. */
async function token(s: Signer, over: Record<string, unknown> = {}, nowMs = T0): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const claims: Record<string, unknown> = {
    iss: entraIssuer(TENANT),
    aud: AUDIENCE,
    tid: TENANT,
    oid: OID,
    scp: `${SCOPE} User.Read`,
    name: "Ada Lovelace",
    preferred_username: "ada@corp.example",
    ver: "2.0",
    iat,
    nbf: iat,
    exp: iat + 3600,
    ...over,
  };
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: s.kid, typ: "JWT" }).sign(s.pair.privateKey);
}

function harness(jwks: () => JWK[], start = T0) {
  let t = start;
  let fetches = 0;
  let failing: Error | null = null;
  const verifier = createEntraTokenVerifier({
    tenantId: TENANT,
    audience: AUDIENCE,
    requiredScope: SCOPE,
    now: () => t,
    fetchJwks: async () => {
      fetches++;
      if (failing) throw failing;
      return jwks();
    },
  });
  return {
    verifier,
    fetches: () => fetches,
    advance: (ms: number) => { t += ms; },
    now: () => t,
    fail: (e: Error | null) => { failing = e; },
  };
}

test("the endpoints are the tenant's v2 ones", () => {
  assert.equal(entraJwksUrl(TENANT), `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`);
  assert.equal(entraIssuer(TENANT), `https://login.microsoftonline.com/${TENANT}/v2.0`);
});

test("a good token passes and yields the identity claims", async () => {
  const s = await signer("k1");
  const h = harness(() => [s.jwk]);
  const r = await h.verifier.verify(await token(s, { email: "Ada@Corp.example" }));
  assert.deepEqual(r, {
    ok: true,
    identity: { oid: OID, name: "Ada Lovelace", email: "Ada@Corp.example", preferredUsername: "ada@corp.example" },
  });
  // A second token with the same kid uses the cached key.
  assert.equal((await h.verifier.verify(await token(s))).ok, true);
  assert.equal(h.fetches(), 1);
});

test("empty, garbage and oversized tokens are invalid_token", async () => {
  const s = await signer("k1");
  const h = harness(() => [s.jwk]);
  for (const bad of ["", "not-a-jwt", "a.b.c", "x".repeat(20_000)]) {
    assert.deepEqual(await h.verifier.verify(bad), { ok: false, error: "invalid_token" }, bad.slice(0, 12));
  }
});

test("bad signature: signed by a different key under the published kid", async () => {
  const real = await signer("k1");
  const forger = await signer("k1");
  const h = harness(() => [real.jwk]);
  assert.deepEqual(await h.verifier.verify(await token(forger)), { ok: false, error: "invalid_token" });
});

test("alg none and HS256 are refused", async () => {
  const s = await signer("k1");
  const h = harness(() => [s.jwk]);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(T0 / 1000);
  const body = b64({ iss: entraIssuer(TENANT), aud: AUDIENCE, tid: TENANT, oid: OID, scp: SCOPE, iat, nbf: iat, exp: iat + 3600 });
  const none = `${b64({ alg: "none", kid: "k1" })}.${body}.`;
  assert.deepEqual(await h.verifier.verify(none), { ok: false, error: "invalid_token" });
  // HS256 "signed" with the PUBLIC modulus as the secret — the classic key-confusion attempt.
  const hs = await new SignJWT({ tid: TENANT, oid: OID, scp: SCOPE })
    .setProtectedHeader({ alg: "HS256", kid: "k1" })
    .setIssuer(entraIssuer(TENANT)).setAudience(AUDIENCE).setIssuedAt(iat).setExpirationTime(iat + 3600)
    .sign(new TextEncoder().encode(String(s.jwk.n)));
  assert.deepEqual(await h.verifier.verify(hs), { ok: false, error: "invalid_token" });
  assert.equal(h.fetches(), 0, "the algorithm is refused before any key lookup");
});

test("wrong iss, tid, aud; a v1 issuer; an aud list; a missing or malformed oid", async () => {
  const s = await signer("k1");
  const h = harness(() => [s.jwk]);
  const other = "00000000-0000-0000-0000-000000000000";
  const cases: Record<string, Record<string, unknown>> = {
    "wrong iss": { iss: entraIssuer(other) },
    "v1 issuer": { iss: `https://sts.windows.net/${TENANT}/` },
    "wrong tid": { tid: other },
    "missing tid": { tid: undefined },
    "wrong aud": { aud: other },
    "aud as App ID URI": { aud: `api://${AUDIENCE}` },
    "aud list": { aud: [AUDIENCE, other] },
    "missing oid": { oid: undefined },
    "oid not a guid": { oid: "ada" },
    "missing exp": { exp: undefined },
  };
  for (const [name, over] of Object.entries(cases)) {
    assert.deepEqual(await h.verifier.verify(await token(s, over)), { ok: false, error: "invalid_token" }, name);
  }
});

test("exp and nbf: refused beyond the 60 s skew, accepted inside it", async () => {
  const s = await signer("k1");
  const h = harness(() => [s.jwk]);
  const nowS = Math.floor(T0 / 1000);
  const skew = CLOCK_SKEW_SECONDS;
  assert.deepEqual(await h.verifier.verify(await token(s, { exp: nowS - skew - 5 })), { ok: false, error: "invalid_token" }, "expired");
  assert.equal((await h.verifier.verify(await token(s, { exp: nowS - skew + 5 }))).ok, true, "expired inside the skew");
  assert.deepEqual(await h.verifier.verify(await token(s, { nbf: nowS + skew + 5 })), { ok: false, error: "invalid_token" }, "not yet valid");
  assert.equal((await h.verifier.verify(await token(s, { nbf: nowS + skew - 5 }))).ok, true, "nbf inside the skew");
});

test("scope: missing scp, a scp without Skills.Sync and an app-only token are insufficient_scope", async () => {
  const s = await signer("k1");
  const h = harness(() => [s.jwk]);
  assert.deepEqual(await h.verifier.verify(await token(s, { scp: undefined })), { ok: false, error: "insufficient_scope" });
  assert.deepEqual(await h.verifier.verify(await token(s, { scp: "User.Read Skills.SyncAll" })), { ok: false, error: "insufficient_scope" });
  assert.deepEqual(await h.verifier.verify(await token(s, { scp: "skills.sync" })), { ok: false, error: "insufficient_scope" }, "case-sensitive");
  assert.deepEqual(await h.verifier.verify(await token(s, { scp: undefined, roles: ["Skills.Sync"], idtyp: "app" })), { ok: false, error: "insufficient_scope" });
  assert.equal((await h.verifier.verify(await token(s, { scp: "Skills.Sync" }))).ok, true);
});

test("a token invalid on BOTH counts is invalid_token, not insufficient_scope", async () => {
  const s = await signer("k1");
  const h = harness(() => [s.jwk]);
  const r = await h.verifier.verify(await token(s, { scp: "User.Read", aud: "00000000-0000-0000-0000-000000000000" }));
  assert.deepEqual(r, { ok: false, error: "invalid_token" });
});

test("unknown kid: one refetch, then no more for a minute; a rotated-in key is picked up after it", async () => {
  const k1 = await signer("k1");
  const k2 = await signer("k2");
  let published = [k1.jwk];
  const h = harness(() => published);
  assert.equal((await h.verifier.verify(await token(k1))).ok, true);
  assert.equal(h.fetches(), 1);

  // k2 is not published: the first unknown kid inside the cooldown must NOT refetch (the load
  // above just happened), and repeats never do.
  const t2 = await token(k2);
  for (let i = 0; i < 5; i++) assert.deepEqual(await h.verifier.verify(t2), { ok: false, error: "invalid_token" });
  assert.equal(h.fetches(), 1, "no refetch inside the cooldown");

  // Entra rotates k2 in. Still refused until the cooldown has passed …
  published = [k1.jwk, k2.jwk];
  h.advance(UNKNOWN_KID_REFETCH_MS - 1000);
  assert.equal((await h.verifier.verify(await token(k2, {}, h.now()))).ok, false);
  assert.equal(h.fetches(), 1);
  // … then exactly one refetch finds it.
  h.advance(2000);
  assert.equal((await h.verifier.verify(await token(k2, {}, h.now()))).ok, true);
  assert.equal(h.fetches(), 2);

  // A flood of tokens with a kid that never exists costs one fetch per minute, not one each.
  const ghost = await signer("ghost");
  h.advance(UNKNOWN_KID_REFETCH_MS + 1);
  for (let i = 0; i < 10; i++) assert.equal((await h.verifier.verify(await token(ghost, {}, h.now()))).ok, false);
  assert.equal(h.fetches(), 3);
});

test("keys unavailable: no cache and a failing fetch throws (500), then recovers", async () => {
  const s = await signer("k1");
  const h = harness(() => [s.jwk]);
  h.fail(new Error("ENOTFOUND login.microsoftonline.com"));
  await assert.rejects(h.verifier.verify(await token(s)), SigningKeysUnavailableError);
  // Inside the short retry window it does not hammer the endpoint, and is still a 500 — not a 401.
  await assert.rejects(h.verifier.verify(await token(s)), SigningKeysUnavailableError);
  assert.equal(h.fetches(), 1);
  h.fail(null);
  h.advance(FAILED_FETCH_RETRY_MS + 1);
  assert.equal((await h.verifier.verify(await token(s, {}, h.now()))).ok, true);
  assert.equal(h.fetches(), 2);
});

test("with keys cached, a failed refresh keeps validating against them", async () => {
  const s = await signer("k1");
  const other = await signer("k9");
  const h = harness(() => [s.jwk]);
  assert.equal((await h.verifier.verify(await token(s))).ok, true);
  h.fail(new Error("timeout"));
  h.advance(UNKNOWN_KID_REFETCH_MS + 1);
  // An unknown kid forces a refresh attempt; it fails; that token is a 401, not a 500 …
  assert.deepEqual(await h.verifier.verify(await token(other, {}, h.now())), { ok: false, error: "invalid_token" });
  // … and tokens signed by the cached key still pass.
  assert.equal((await h.verifier.verify(await token(s, {}, h.now()))).ok, true);
});

test("a JWKS with no usable RSA signing key counts as unavailable; enc-use and non-RSA keys are skipped", async () => {
  const s = await signer("k1");
  const h = harness(() => [{ kty: "EC", kid: "ec1", crv: "P-256", x: "x", y: "y" }, { ...s.jwk, kid: "enc1", use: "enc" }]);
  await assert.rejects(h.verifier.verify(await token(s)), SigningKeysUnavailableError);
});
