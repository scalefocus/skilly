// The platform signing key (SKILLY_SPEC.md §73.9): parsing, the production refusal, the dev key,
// and that a signature made here verifies with the shared (WebCrypto) checker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import {
  buildSkillVersionStatement,
  checkEnvelopeSignature,
  decodeEnvelope,
  envelopeFromSignature,
} from "@skilly/shared";
import { devKeyPath, loadSigningKey, materialFor, parsePrivateKey } from "./key.js";
import type { Pool } from "pg";
import { signerFor } from "./key.js";

const ed25519Pem = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

test("parsePrivateKey: PEM, \\n-escaped PEM (one .env line) and base64 DER all load", async () => {
  const pem = ed25519Pem();
  const a = await materialFor(parsePrivateKey(pem));
  const b = await materialFor(parsePrivateKey(pem.replace(/\n/g, "\\n")));
  const der = parsePrivateKey(pem).export({ type: "pkcs8", format: "der" }).toString("base64");
  const c = await materialFor(parsePrivateKey(der));
  assert.equal(a.keyId, b.keyId);
  assert.equal(a.keyId, c.keyId);
  assert.match(a.keyId, /^[0-9a-f]{16}$/);
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(a.fingerprint.startsWith(a.keyId));
});

test("parsePrivateKey: refuses garbage and non-Ed25519 keys without echoing the key", () => {
  assert.throws(() => parsePrivateKey("not a key"), /not a readable PKCS#8 private key/);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => parsePrivateKey(rsa), /must be an Ed25519 key/);
});

test("loadSigningKey: production without a key refuses (the worker does not start)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skilly-key-"));
  try {
    await assert.rejects(loadSigningKey({ env: { NODE_ENV: "production" }, repoRoot: dir }), /missing required env: SKILLY_SIGNING_KEY/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSigningKey: env, then file; outside production a dev key is made once and reused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skilly-key-"));
  try {
    const pem = ed25519Pem();
    const fromEnv = await loadSigningKey({ env: { SKILLY_SIGNING_KEY: pem }, repoRoot: dir });
    assert.equal(fromEnv.source, "env");
    const file = join(dir, "k.pem");
    await writeFile(file, pem);
    const fromFile = await loadSigningKey({ env: { SKILLY_SIGNING_KEY_FILE: file }, repoRoot: dir });
    assert.equal(fromFile.source, "file");
    assert.equal(fromFile.material.keyId, fromEnv.material.keyId);

    const dev1 = await loadSigningKey({ env: {}, repoRoot: dir });
    const dev2 = await loadSigningKey({ env: {}, repoRoot: dir });
    assert.equal(dev1.source, "dev");
    assert.equal(dev1.material.keyId, dev2.material.keyId, "the dev key is persisted and reused");
    assert.match(await readFile(devKeyPath(dir), "utf8"), /BEGIN PRIVATE KEY/);
    assert.ok(devKeyPath(dir).includes("_skilly"), "kept under a `_` directory, never a servable repo path");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a statement signed by the worker's signer verifies with the shared WebCrypto checker", async () => {
  const material = await materialFor(parsePrivateKey(ed25519Pem()));
  const fakePool = { query: async () => ({ rows: [{ revoked_at: null }] }) } as unknown as Pool;
  const signer = signerFor(fakePool, material);
  assert.equal(await signer.usable(), true);
  const built = await buildSkillVersionStatement({
    registry: "https://skilly.example.com",
    skill: { id: "s", namespace: "ns", slug: "x" },
    version: { id: "v", semver: "1.0.0" },
    variant: null,
    kind: "publish",
    hashRecordedAtPublish: true,
    source: { type: "hosted" },
    artifactSha256: null,
    tagCommit: null,
    signedAt: "2026-11-18T00:00:00.000Z",
    files: [{ path: "SKILL.md", bytes: new TextEncoder().encode("# x\n") }],
  });
  const env = envelopeFromSignature(built.payload, signer.keyId, signer.signPayload(built.payload));
  const status = await checkEnvelopeSignature(decodeEnvelope(env)!, [{ keyId: material.keyId, publicKeyPem: material.publicKeyPem, revokedAt: null }], "https://skilly.example.com");
  assert.equal(status, "valid");
});

test("signer.usable(): false for a revoked key (cached), so nothing is signed", async () => {
  const material = await materialFor(parsePrivateKey(ed25519Pem()));
  let calls = 0;
  const fakePool = {
    query: async (sql: string) => {
      if (/insert into system_event/.test(sql)) return { rows: [] };
      calls++;
      return { rows: [{ revoked_at: new Date() }] };
    },
  } as unknown as Pool;
  const signer = signerFor(fakePool, material);
  assert.equal(await signer.usable(), false);
  assert.equal(await signer.usable(), false);
  assert.equal(calls, 1, "the revocation check is cached");
});
