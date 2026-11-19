// Signed skill versions (SKILLY_SPEC.md §73): statement building, DSSE/PAE, signature checking and
// the shared verdict function. Signing here uses node:crypto exactly as the worker does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  buildSkillVersionStatement,
  checkEnvelopeSignature,
  compareFiles,
  decodeEnvelope,
  describeFiles,
  describeLocalFiles,
  envelopeFromSignature,
  fingerprintFromSpki,
  formatFingerprint,
  keyIdFromSpki,
  paeBytes,
  pemToDer,
  derToPem,
  resolveSigningRegistry,
  variantFor,
  verifyAgainstStatement,
  DSSE_PAYLOAD_TYPE,
  type BuildStatementInput,
  type PublicSigningKey,
} from "./attestation.js";

const enc = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const REGISTRY = "https://skilly.example.com";

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKey, der, pem };
}

function input(files: BuildStatementInput["files"], over: Partial<BuildStatementInput> = {}): BuildStatementInput {
  return {
    registry: REGISTRY,
    skill: { id: "11111111-1111-1111-1111-111111111111", namespace: "team-a", slug: "deploy" },
    version: { id: "22222222-2222-2222-2222-222222222222", semver: "1.2.0" },
    variant: null,
    kind: "publish",
    hashRecordedAtPublish: true,
    source: { type: "hosted" },
    artifactSha256: "a".repeat(64),
    tagCommit: "b".repeat(40),
    signedAt: "2026-11-18T10:00:00.000Z",
    files,
    ...over,
  };
}

const FILES = [
  { path: "scripts/run.sh", bytes: enc("#!/bin/sh\r\necho hi\r\n"), mode: "100755" as const },
  { path: "SKILL.md", bytes: enc("---\nname: deploy\n---\n# Deploy\n") },
  { path: "metadata.json", bytes: enc("{}") },
];

async function signed(files = FILES, over: Partial<BuildStatementInput> = {}) {
  const kp = keyPair();
  const keyId = await keyIdFromSpki(kp.der);
  const built = await buildSkillVersionStatement(input(files, over));
  const sig = new Uint8Array(sign(null, Buffer.from(paeBytes(DSSE_PAYLOAD_TYPE, built.payload)), kp.privateKey));
  const envelope = envelopeFromSignature(built.payload, keyId, sig);
  const keys: PublicSigningKey[] = [{ keyId, publicKeyPem: kp.pem, revokedAt: null }];
  return { built, envelope, keys, keyId, kp };
}

test("describeFiles: sorted by path bytes, raw + LF digests, mode, installed flag", async () => {
  const files = await describeFiles(FILES);
  assert.deepEqual(files.map((f) => f.path), ["SKILL.md", "metadata.json", "scripts/run.sh"]);
  const run = files.find((f) => f.path === "scripts/run.sh")!;
  assert.equal(run.mode, "100755");
  assert.equal(run.sha256, sha("#!/bin/sh\r\necho hi\r\n"));
  assert.equal(run.lfSha256, sha("#!/bin/sh\necho hi\n"));
  const md = files.find((f) => f.path === "SKILL.md")!;
  assert.equal(md.lfSha256, md.sha256, "no CRLF => lfSha256 equals sha256");
  assert.equal(files.find((f) => f.path === "metadata.json")!.installed, false);
});

test("statement: in-toto shape, every file a subject, computedHash over installed files only", async () => {
  const { built } = await signed();
  const st = built.statement;
  assert.equal(st._type, "https://in-toto.io/Statement/v1");
  assert.equal(st.subject.length, 3);
  assert.equal(st.predicate.skillsLock.lockVersion, 2);
  // metadata.json is excluded from the lock hash, like the installer.
  const without = await buildSkillVersionStatement(input(FILES.filter((f) => f.path !== "metadata.json")));
  assert.equal(built.computedHash, without.computedHash);
  assert.equal(st.predicate.artifactSha256, "a".repeat(64));
  // The payload is the exact JSON of the statement (stored and served verbatim).
  assert.deepEqual(JSON.parse(new TextDecoder().decode(built.payload)), st);
});

test("statement: a variant carries no artifactSha256", async () => {
  const variant = await variantFor(["deprecation"], { successor: "team-a/deploy2", note: null, successorUrl: "https://x/skills/team-a/deploy2" });
  const built = await buildSkillVersionStatement(input(FILES, { variant }));
  assert.equal(built.statement.predicate.artifactSha256, null);
  assert.deepEqual(built.statement.predicate.variant, variant);
});

test("variantFor: sorted rewrites; inputs change the identity; hoist has no inputs", async () => {
  const a = await variantFor(["marketplace_hoist", "deprecation"], { successor: null, note: "x", successorUrl: null });
  assert.deepEqual(a.rewrites, ["deprecation", "marketplace_hoist"]);
  const b = await variantFor(["deprecation", "marketplace_hoist"], { successor: null, note: "y", successorUrl: null });
  assert.notEqual(a.inputsSha256, b.inputsSha256);
  const h1 = await variantFor(["marketplace_hoist"], { successor: null, note: "ignored", successorUrl: null });
  const h2 = await variantFor(["marketplace_hoist"], null);
  assert.equal(h1.inputsSha256, h2.inputsSha256);
});

test("PAE: DSSEv1 SP len(type) SP type SP len(body) SP body", () => {
  const pae = new TextDecoder().decode(paeBytes("application/vnd.in-toto+json", enc("{}")));
  assert.equal(pae, "DSSEv1 28 application/vnd.in-toto+json 2 {}");
});

test("signature: valid, then invalid when tampered, unknown key, or another registry", async () => {
  const { envelope, keys } = await signed();
  const decoded = decodeEnvelope(envelope)!;
  assert.ok(decoded);
  assert.equal(await checkEnvelopeSignature(decoded, keys, REGISTRY), "valid");
  assert.equal(await checkEnvelopeSignature(decoded, keys, `${REGISTRY}/`), "valid", "trailing slash is the same registry");
  assert.equal(await checkEnvelopeSignature(decoded, keys, "https://other.example.com"), "invalid");
  assert.equal(await checkEnvelopeSignature(decoded, [], REGISTRY), "invalid");

  // Tamper with one file digest inside the payload: the signature no longer matches.
  const st = JSON.parse(new TextDecoder().decode(decoded.payload));
  st.predicate.files[0].sha256 = "0".repeat(64);
  const forged = { ...envelope, payload: Buffer.from(JSON.stringify(st)).toString("base64") };
  assert.equal(await checkEnvelopeSignature(decodeEnvelope(forged)!, keys, REGISTRY), "invalid");
});

test("signature: a good signature by a revoked key is revoked_key", async () => {
  const { envelope, keys } = await signed();
  const revoked = keys.map((k) => ({ ...k, revokedAt: "2026-11-18T00:00:00Z" }));
  assert.equal(await checkEnvelopeSignature(decodeEnvelope(envelope)!, revoked, REGISTRY), "revoked_key");
});

test("decodeEnvelope rejects other payload types and non-statements", async () => {
  const { envelope } = await signed();
  assert.equal(decodeEnvelope({ ...envelope, payloadType: "text/plain" }), null);
  assert.equal(decodeEnvelope({ ...envelope, payload: Buffer.from("{\"a\":1}").toString("base64") }), null);
  assert.equal(decodeEnvelope({ ...envelope, signatures: [] }), null);
  assert.equal(decodeEnvelope(null), null);
});

test("keys: keyId is the first 16 hex of sha256(DER SPKI); PEM round trip; fingerprint groups", async () => {
  const kp = keyPair();
  assert.equal(await keyIdFromSpki(kp.der), sha(kp.der).slice(0, 16));
  assert.equal(await fingerprintFromSpki(kp.der), sha(kp.der));
  assert.deepEqual([...pemToDer(kp.pem)!], [...kp.der]);
  assert.deepEqual([...pemToDer(derToPem(kp.der))!], [...kp.der]);
  assert.equal(formatFingerprint("0123456789abcdef"), "0123 4567 89ab cdef");
  assert.equal(pemToDer("not a pem"), null);
  assert.equal(pemToDer("-----BEGIN PUBLIC KEY-----"), null, "no END line");
  assert.equal(pemToDer("-----BEGIN X----------END X-----"), null, "empty body");
  // CodeQL: crafted BEGIN repetitions and long slash runs stay linear (they used to be regexes).
  const hostile = "-----BEGIN  -----a".repeat(50_000);
  const t0 = Date.now();
  assert.equal(pemToDer(`-----BEGIN  -----${hostile}`), null);
  assert.equal(resolveSigningRegistry({ SKILLY_REGISTRY_URL: `https://x${"/".repeat(100_000)}` }), "https://x");
  assert.ok(Date.now() - t0 < 1000, "linear on hostile input");
});

test("compareFiles: unchanged, line endings, modified, missing, extra (OS metadata labeled)", async () => {
  const signedFiles = await describeFiles(FILES);
  const local = await describeLocalFiles([
    { path: "SKILL.md", bytes: enc("---\nname: deploy\n---\n# Deploy\n") },
    { path: "scripts/run.sh", bytes: enc("#!/bin/sh\necho hi\n") }, // LF on disk, CRLF signed
    { path: ".DS_Store", bytes: enc("junk") },
    { path: "metadata.json", bytes: enc("ignored") },
  ]);
  const cmp = compareFiles(local, signedFiles);
  const by = Object.fromEntries(cmp.files.map((f) => [f.path, f]));
  assert.equal(by["SKILL.md"]!.status, "unchanged");
  assert.equal(by["scripts/run.sh"]!.status, "line_endings");
  assert.equal(by[".DS_Store"]!.status, "extra");
  assert.equal(by[".DS_Store"]!.osMetadata, true);
  assert.equal(by["metadata.json"], undefined, "installer-excluded files are not compared");
  assert.equal(cmp.matches, false, "an extra file is a change, even OS metadata");

  const missing = compareFiles(local.filter((f) => f.path === "SKILL.md"), signedFiles);
  assert.equal(missing.files.find((f) => f.path === "scripts/run.sh")!.status, "missing");

  const modified = compareFiles([{ path: "SKILL.md", sha256: "0".repeat(64) }, ...local.filter((f) => f.path === "scripts/run.sh")], signedFiles);
  assert.equal(modified.files.find((f) => f.path === "SKILL.md")!.status, "modified");
});

test("compareFiles: a supplied mode that differs is a modification", async () => {
  const signedFiles = await describeFiles(FILES);
  const local = await describeLocalFiles(FILES);
  const runIdx = local.findIndex((f) => f.path === "scripts/run.sh");
  local[runIdx] = { ...local[runIdx]!, mode: "100644" };
  const cmp = compareFiles(local, signedFiles);
  const run = cmp.files.find((f) => f.path === "scripts/run.sh")!;
  assert.equal(run.status, "modified");
  assert.equal(run.modeChanged, true);
});

test("verifyAgainstStatement: version match, variant match, other version, changed", async () => {
  const base = await describeFiles(FILES);
  const hinted = FILES.map((f) => (f.path === "SKILL.md" ? { ...f, bytes: enc("---\nname: deploy\ndescription: DEPRECATED\n---\n# Deploy\n") } : f));
  const variant = await variantFor(["deprecation"], { successor: null, note: null, successorUrl: null });
  const candidates = [
    { variant: null, files: base, signature: "valid" as const },
    { variant, files: await describeFiles(hinted), signature: "valid" as const },
  ];

  const exact = verifyAgainstStatement(await describeLocalFiles(FILES), candidates);
  assert.equal(exact.overall, "match");
  assert.equal(exact.variant, null);

  const viaVariant = verifyAgainstStatement(await describeLocalFiles(hinted), candidates);
  assert.equal(viaVariant.overall, "match");
  assert.deepEqual(viaVariant.variant, variant);

  const edited = FILES.map((f) => (f.path === "SKILL.md" ? { ...f, bytes: enc("tampered") } : f));
  const changed = verifyAgainstStatement(await describeLocalFiles(edited), candidates);
  assert.equal(changed.overall, "changed");
  assert.equal(changed.counts.modified, 1);

  const other = verifyAgainstStatement(await describeLocalFiles(edited), candidates, { otherVersionSemver: "1.1.0" });
  assert.equal(other.overall, "match_other_version");
  assert.equal(other.otherVersion, "1.1.0");
});

test("verifyAgainstStatement: no statement at all reports every file as extra", () => {
  const v = verifyAgainstStatement([{ path: "SKILL.md", sha256: "0".repeat(64) }], []);
  assert.equal(v.overall, "changed");
  assert.equal(v.signature, "invalid");
  assert.equal(v.files[0]!.status, "extra");
});
