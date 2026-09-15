// Unit tests for the authorize-request duplicate-parameter guard (SKILLY_SPEC.md §29).
//
// No DB needed: the guard runs BEFORE client_id/redirect_uri are read, so it returns without ever
// reaching findClient(). That ordering is the point of the test — a duplicated `redirect_uri` must
// not be collapsed to the registered value and treated as verified, which is exactly what the old
// `params.set(k, v[0])` collapse in the authorize page did.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAuthorizeRequest } from "./mcpOauth";

const REDIRECT = "http://127.0.0.1:8976/callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/** A well-formed authorize query, as a client would send it. */
function authorizeParams(extra: Array<[string, string]> = []): URLSearchParams {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: "mcp_whatever",
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "unit-state",
  });
  for (const [k, v] of extra) p.append(k, v);
  return p;
}

test("a duplicated redirect_uri is rejected, not collapsed to the registered one", async () => {
  const check = await checkAuthorizeRequest(authorizeParams([["redirect_uri", "https://evil.example.com/cb"]]));
  assert.equal(check.ok, false);
  assert.ok("error" in check, "must render an error page, never redirect");
  assert.match(check.error, /redirect_uri parameter was supplied more than once/);
  // The attacker's URI must not appear anywhere in the response.
  assert.doesNotMatch(check.error, /evil\.example\.com/);
});

test("the duplicate guard fires before the client is looked up", async () => {
  // client_id is duplicated, so this must fail closed on the guard rather than hitting the DB
  // (findClient would throw without a live pool — reaching it at all is the regression).
  const check = await checkAuthorizeRequest(authorizeParams([["client_id", "mcp_other"]]));
  assert.equal(check.ok, false);
  assert.ok("error" in check);
  assert.match(check.error, /client_id parameter was supplied more than once/);
});

test("any repeated parameter is rejected, not just the security-sensitive ones", async () => {
  for (const key of ["state", "code_challenge", "code_challenge_method", "response_type", "scope"]) {
    // Append twice rather than once, so the case holds for keys the base query omits (`scope`) —
    // appending a single value to an absent key is not a repeat, and would fall through to the DB.
    const check = await checkAuthorizeRequest(authorizeParams([[key, "second-value"], [key, "third-value"]]));
    assert.equal(check.ok, false, `${key} duplicated must fail`);
    assert.ok("error" in check, `${key} duplicated must not redirect`);
    assert.match(check.error, new RegExp(`${key} parameter was supplied more than once`));
  }
});

test("a repeat of the SAME value is still a repeat (OAuth 2.1 counts occurrences)", async () => {
  const check = await checkAuthorizeRequest(authorizeParams([["redirect_uri", REDIRECT]]));
  assert.equal(check.ok, false);
  assert.ok("error" in check);
  assert.match(check.error, /redirect_uri parameter was supplied more than once/);
});
