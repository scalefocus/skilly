// Unit tests for the recoverable install-token copy (SKILLY_SPEC.md §23 "Show install URL").
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { INSTALL_TOKEN_ENC_KEY_ENV, installTokenKey, openInstallToken, sealInstallToken } from "./install-crypto.js";

const keyB64 = randomBytes(32).toString("base64");
const key = Buffer.from(keyB64, "base64");

test("installTokenKey: parses a 32-byte base64 key from the env; unset/invalid → null (feature off)", () => {
  assert.deepEqual(installTokenKey({ [INSTALL_TOKEN_ENC_KEY_ENV]: keyB64 }), key);
  assert.equal(installTokenKey({}), null);
  assert.equal(installTokenKey({ [INSTALL_TOKEN_ENC_KEY_ENV]: "" }), null);
  assert.equal(installTokenKey({ [INSTALL_TOKEN_ENC_KEY_ENV]: randomBytes(16).toString("base64") }), null);
});

test("sealInstallToken → openInstallToken round-trips, in the shared v1: format, never the plaintext", () => {
  const raw = "tok_" + randomBytes(24).toString("base64url");
  const enc = sealInstallToken(raw, key);
  assert.ok(enc);
  assert.match(enc, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.ok(!enc.includes(raw));
  assert.equal(openInstallToken(enc, key), raw);
  // Random IV: sealing the same token twice yields different ciphertexts.
  assert.notEqual(sealInstallToken(raw, key), enc);
});

test("no key → nothing stored and nothing revealable", () => {
  assert.equal(sealInstallToken("abc", null), null);
  const enc = sealInstallToken("abc", key)!;
  assert.equal(openInstallToken(enc, null), null);
  assert.equal(openInstallToken(null, key), null);
});

test("a rotated key or a tampered copy opens to null (→ 'generate a new one'), never throws", () => {
  const enc = sealInstallToken("abc", key)!;
  assert.equal(openInstallToken(enc, randomBytes(32)), null);
  const [v, iv, tag, ct] = enc.split(":");
  const flipped = Buffer.from(ct!, "base64");
  flipped[0] = flipped[0]! ^ 0xff;
  assert.equal(openInstallToken([v, iv, tag, flipped.toString("base64")].join(":"), key), null);
  assert.equal(openInstallToken("garbage", key), null);
});
