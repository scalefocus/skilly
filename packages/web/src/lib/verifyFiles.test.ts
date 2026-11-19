// Unit tests for the browser side of signed skill versions (SKILLY_SPEC.md §73.7, §73.8): picking a
// folder, the candidates handed to the shared verdict function, other-version detection, bundles,
// reports and skills-lock.json parsing. Statements are signed here with node:crypto exactly as the
// worker signs them, and checked with the same WebCrypto code the browser runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  buildSkillVersionStatement,
  envelopeFromSignature,
  keyIdFromSpki,
  paeBytes,
  variantFor,
  DSSE_PAYLOAD_TYPE,
  type BuildStatementInput,
  type DsseEnvelope,
  type StatementVariant,
} from "@skilly/shared/attestation";
import { skillsLockComputedHash } from "@skilly/shared/external-tool";
import {
  buildCandidates,
  bundleMessage,
  bundleVerdict,
  checkStatements,
  chunk,
  countsLine,
  decideVerification,
  fileNote,
  hashFolder,
  installVerifySemver,
  isBundleName,
  kindNote,
  lockHashes,
  matchLabel,
  movedNote,
  normalizePickedPath,
  offlineRecipe,
  otherVersionMatch,
  parseSkillsLock,
  prepareFolder,
  reportBody,
  signatureBadge,
  signatureLine,
  statementDownloadUrl,
  statementFileName,
  statusNote,
  stripTopFolder,
  variantName,
  verdictHeadline,
  NO_LOCK_HASH,
  type SigningKeysDocument,
  type StatementEntry,
  type StatementResponse,
} from "./verifyFiles";

const te = new TextEncoder();
const enc = (s: string) => te.encode(s);
const REGISTRY = "https://skilly.example.com";
const H = (c: string) => c.repeat(64);

const FILES = [
  { path: "SKILL.md", bytes: enc("---\nname: deploy\n---\n# Deploy\n") },
  { path: "scripts/run.sh", bytes: enc("#!/bin/sh\necho hi\n") },
];

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKey, der, pem };
}

type Kp = ReturnType<typeof keyPair>;

function input(files: BuildStatementInput["files"], over: Partial<BuildStatementInput> = {}): BuildStatementInput {
  return {
    registry: REGISTRY,
    skill: { id: "11111111-1111-1111-1111-111111111111", namespace: "team-a", slug: "deploy" },
    version: { id: "22222222-2222-2222-2222-222222222222", semver: "1.2.0" },
    variant: null,
    kind: "publish",
    hashRecordedAtPublish: true,
    source: { type: "hosted" },
    artifactSha256: H("a"),
    tagCommit: "b".repeat(40),
    signedAt: "2026-11-18T10:00:00.000Z",
    files,
    ...over,
  };
}

async function signEntry(kp: Kp, files: BuildStatementInput["files"], over: Partial<BuildStatementInput> = {}): Promise<StatementEntry> {
  const keyId = await keyIdFromSpki(kp.der);
  const built = await buildSkillVersionStatement(input(files, over));
  const sig = new Uint8Array(sign(null, Buffer.from(paeBytes(DSSE_PAYLOAD_TYPE, built.payload)), kp.privateKey));
  const envelope: DsseEnvelope = envelopeFromSignature(built.payload, keyId, sig);
  return {
    variant: over.variant ?? null,
    kind: over.kind ?? "publish",
    keyId,
    keyStatus: "active",
    signedAt: "2026-11-18T10:00:00.000Z",
    computedHash: built.computedHash,
    envelope,
    serverSignature: "valid",
  };
}

async function keysDoc(kp: Kp, over: Partial<SigningKeysDocument["keys"][number]> = {}, registry = REGISTRY): Promise<SigningKeysDocument> {
  return {
    registry,
    keys: [{ keyId: await keyIdFromSpki(kp.der), algorithm: "ed25519", publicKeyPem: kp.pem, fingerprint: H("f"), createdAt: "2026-01-01T00:00:00Z", retiredAt: null, revokedAt: null, ...over }],
  };
}

/** The deprecated SKILL.md a variant serves, and the version + variant statements. */
async function fixture() {
  const kp = keyPair();
  const variant: StatementVariant = await variantFor(["deprecation"], { successor: "team-a/deploy2", note: "Use deploy2", successorUrl: null });
  const depFiles = [{ path: "SKILL.md", bytes: enc("---\nname: deploy\n---\n> Deprecated: use deploy2\n# Deploy\n") }, FILES[1]!];
  const base = await signEntry(kp, FILES);
  const dep = await signEntry(kp, depFiles, { variant, artifactSha256: null });
  const otherFiles = [{ path: "SKILL.md", bytes: enc("---\nname: deploy\n---\n# Deploy v1.1\n") }, FILES[1]!];
  const resp: StatementResponse = {
    registry: REGISTRY,
    semver: "1.2.0",
    status: "active",
    statements: [base, dep],
    otherVersions: [
      { semver: "1.0.0", status: "active", computedHash: await skillsLockComputedHash(otherFiles) },
      { semver: "1.1.0", status: "yanked", computedHash: await skillsLockComputedHash(otherFiles) },
    ],
  };
  return { kp, variant, depFiles, otherFiles, resp, keys: await keysDoc(kp) };
}

// ---------------------------------------------------------------------------
// Picking a folder
// ---------------------------------------------------------------------------

test("normalizePickedPath: backslashes, a leading slash and ./ go", () => {
  assert.equal(normalizePickedPath("/my-skill/SKILL.md"), "my-skill/SKILL.md");
  assert.equal(normalizePickedPath("./scripts/run.sh"), "scripts/run.sh");
  assert.equal(normalizePickedPath("my-skill\\scripts\\run.sh"), "my-skill/scripts/run.sh");
});

test("stripTopFolder: strips the picked folder's own name (input and drop forms)", () => {
  const picked = stripTopFolder([{ path: "deploy/SKILL.md" }, { path: "deploy/scripts/run.sh" }]);
  assert.equal(picked.top, "deploy");
  assert.deepEqual(picked.files.map((f) => f.path), ["SKILL.md", "scripts/run.sh"]);
  const dropped = stripTopFolder([{ path: "/deploy/SKILL.md" }]);
  assert.equal(dropped.top, "deploy");
  assert.deepEqual(dropped.files.map((f) => f.path), ["SKILL.md"]);
});

test("stripTopFolder: loose files, or folders that differ, keep their paths", () => {
  const loose = stripTopFolder([{ path: "/SKILL.md" }, { path: "/scripts/run.sh" }]);
  assert.equal(loose.top, null);
  assert.deepEqual(loose.files.map((f) => f.path), ["SKILL.md", "scripts/run.sh"]);
  const two = stripTopFolder([{ path: "a/SKILL.md" }, { path: "b/SKILL.md" }]);
  assert.equal(two.top, null);
  assert.deepEqual(two.files.map((f) => f.path), ["a/SKILL.md", "b/SKILL.md"]);
});

test("prepareFolder: installer exclusions are skipped and counted; SKILL.md is noticed", () => {
  const r = prepareFolder(
    [
      { path: "deploy/SKILL.md", size: 10 },
      { path: "deploy/metadata.json", size: 5 },
      { path: "deploy/.git/HEAD", size: 999 },
      { path: "deploy/lib/__pycache__/x.pyc", size: 999 },
      { path: "deploy/scripts/run.sh", size: 20 },
    ],
    { maxBytes: 100 },
  );
  assert.ok(r.ok);
  assert.deepEqual(r.files.map((f) => f.path), ["SKILL.md", "scripts/run.sh"]);
  assert.equal(r.skipped, 3);
  assert.equal(r.totalBytes, 30, "excluded files don't count toward the cap");
  assert.equal(r.top, "deploy");
  assert.equal(r.hasSkillMd, true);
});

test("prepareFolder: empty folders, the size cap and the file cap are refused before reading", () => {
  const empty = prepareFolder([], { maxBytes: 100 });
  assert.equal(empty.ok, false);
  const big = prepareFolder([{ path: "d/SKILL.md", size: 60 * 1024 * 1024 }], { maxBytes: 50 * 1024 * 1024 });
  assert.equal(big.ok, false);
  if (!big.ok) assert.match(big.error, /60 MB, bigger than the allowed size of 50 MB/);
  const many = prepareFolder([{ path: "a", size: 1 }, { path: "b", size: 1 }, { path: "c", size: 1 }], { maxBytes: 100, maxFiles: 2 });
  assert.equal(many.ok, false);
  if (!many.ok) assert.match(many.error, /3 files, more than 2/);
  const onlyMeta = prepareFolder([{ path: "d/metadata.json", size: 1 }], { maxBytes: 100 });
  assert.equal(onlyMeta.ok, false);
  const noMd = prepareFolder([{ path: "d/README.md", size: 1 }], { maxBytes: 100 });
  assert.ok(noMd.ok);
  assert.equal(noMd.hasSkillMd, false);
});

test("isBundleName: .zip, .tar.gz, .tgz and .skill only", () => {
  for (const n of ["a.zip", "a.tar.gz", "A.TGZ", "deploy.skill"]) assert.equal(isBundleName(n), true, n);
  for (const n of ["SKILL.md", "a.tar", "a.gz", "a.json"]) assert.equal(isBundleName(n), false, n);
});

// ---------------------------------------------------------------------------
// Statements, candidates, verdicts
// ---------------------------------------------------------------------------

test("checkStatements: browser check with the public keys; skilly's result without them", async () => {
  const { resp, keys } = await fixture();
  const browser = await checkStatements(resp, keys);
  assert.deepEqual(browser.map((c) => c.signature), ["valid", "valid"]);
  assert.ok(browser.every((c) => c.decoded));
  const server = await checkStatements({ ...resp, statements: resp.statements.map((s) => ({ ...s, serverSignature: "revoked_key" as const })) }, null);
  assert.deepEqual(server.map((c) => c.signature), ["revoked_key", "revoked_key"]);
});

test("checkStatements: a revoked key, another registry and a broken envelope", async () => {
  const { kp, resp } = await fixture();
  assert.equal((await checkStatements(resp, await keysDoc(kp, { revokedAt: "2026-11-01T00:00:00Z" })))[0]!.signature, "revoked_key");
  assert.equal((await checkStatements(resp, await keysDoc(kp, {}, "https://other.example.com")))[0]!.signature, "invalid");
  assert.equal((await checkStatements(resp, await keysDoc(keyPair())))[0]!.signature, "invalid", "an unknown key");
  const broken = await checkStatements({ ...resp, statements: [{ ...resp.statements[0]!, envelope: { nope: 1 } }] }, await keysDoc(kp));
  assert.equal(broken[0]!.decoded, null);
  assert.equal(broken[0]!.signature, "invalid");
});

test("buildCandidates: the version's own statement first, then the variants, with their files", async () => {
  const { resp, keys, variant } = await fixture();
  const checked = await checkStatements({ ...resp, statements: [resp.statements[1]!, resp.statements[0]!] }, keys);
  const c = buildCandidates(checked);
  assert.equal(c[0]!.variant, null);
  assert.equal(c[1]!.variant?.inputsSha256, variant.inputsSha256);
  assert.deepEqual(c[0]!.files.map((f) => f.path), ["SKILL.md", "scripts/run.sh"]);
  // An undecodable statement still holds its place, with nothing to match.
  const broken = buildCandidates(await checkStatements({ ...resp, statements: [{ ...resp.statements[0]!, envelope: null }] }, keys));
  assert.equal(broken.length, 1);
  assert.deepEqual(broken[0]!.files, []);
});

test("decideVerification: the version's own files are Unchanged", async () => {
  const { resp, keys } = await fixture();
  const checked = await checkStatements(resp, keys);
  const { local, computedHash } = await hashFolder(FILES);
  const out = decideVerification(local, computedHash, resp, checked);
  assert.equal(out.verdict.overall, "match");
  assert.equal(out.verdict.signature, "valid");
  assert.equal(out.verdict.variant, null);
  assert.equal(out.statement, checked[0]);
  assert.deepEqual(verdictHeadline(out, "1.2.0"), { text: "Unchanged: v1.2.0", tone: "ok" });
  assert.equal(countsLine(out.verdict.counts), "2 signed files · 2 unchanged");
});

test("decideVerification: a variant match names its rewrites", async () => {
  const { resp, keys, depFiles, variant } = await fixture();
  const checked = await checkStatements(resp, keys);
  const { local, computedHash } = await hashFolder(depFiles);
  const out = decideVerification(local, computedHash, resp, checked);
  assert.equal(out.verdict.overall, "match");
  assert.equal(out.verdict.variant?.inputsSha256, variant.inputsSha256);
  assert.equal(out.statement, checked[1]);
  assert.equal(verdictHeadline(out, "1.2.0").text, "Unchanged: v1.2.0 with skilly's deprecation notice");
});

test("decideVerification: CRLF line endings still match; a changed file is Modified", async () => {
  const { resp, keys } = await fixture();
  const checked = await checkStatements(resp, keys);
  const crlf = [{ path: "SKILL.md", bytes: enc("---\r\nname: deploy\r\n---\r\n# Deploy\r\n") }, FILES[1]!];
  const a = await hashFolder(crlf);
  const le = decideVerification(a.local, a.computedHash, resp, checked);
  assert.equal(le.verdict.overall, "match");
  assert.equal(le.verdict.files.find((f) => f.path === "SKILL.md")!.status, "line_endings");
  assert.match(fileNote(le.verdict.files.find((f) => f.path === "SKILL.md")!)!, /line endings/);

  const edited = [{ path: "SKILL.md", bytes: enc("---\nname: deploy\n---\n# Deploy (edited)\n") }, FILES[1]!, { path: ".DS_Store", bytes: enc("x") }];
  const b = await hashFolder(edited);
  const ch = decideVerification(b.local, b.computedHash, resp, checked);
  assert.equal(ch.verdict.overall, "changed");
  assert.equal(ch.statement, checked[0], "a mismatch is reported against the version's own statement");
  assert.equal(ch.verdict.files.find((f) => f.path === "SKILL.md")!.status, "modified");
  const ds = ch.verdict.files.find((f) => f.path === ".DS_Store")!;
  assert.equal(ds.status, "extra");
  assert.equal(fileNote(ds), "Probably harmless (OS metadata)");
  assert.equal(verdictHeadline(ch, "1.2.0").tone, "danger");
  assert.equal(countsLine(ch.verdict.counts), "2 signed files · 1 unchanged · 1 modified · 1 extra");
});

test("decideVerification: another version's files are named (match_other_version)", async () => {
  const { resp, keys, otherFiles } = await fixture();
  const checked = await checkStatements(resp, keys);
  const { local, computedHash } = await hashFolder(otherFiles);
  const out = decideVerification(local, computedHash, resp, checked);
  assert.equal(out.verdict.overall, "match_other_version");
  assert.equal(out.verdict.otherVersion, "1.1.0", "the highest version with these files");
  assert.deepEqual(out.otherVersion, { semver: "1.1.0", status: "yanked" });
  assert.deepEqual(verdictHeadline(out, "1.2.0"), { text: "These files are v1.1.0, not v1.2.0.", tone: "warn" });
});

test("otherVersionMatch: never the version itself; case-insensitive; null when none", () => {
  const others = [
    { semver: "1.2.0", status: "active", computedHash: H("c") },
    { semver: "1.0.0", status: "active", computedHash: H("c") },
    { semver: "1.10.0", status: "active", computedHash: H("c") },
  ];
  assert.deepEqual(otherVersionMatch(H("C"), others, "1.2.0"), { semver: "1.10.0", status: "active" });
  assert.equal(otherVersionMatch(H("d"), others, "1.2.0"), null);
});

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

test("signatureLine: browser vs skilly-checked, revoked, invalid", () => {
  assert.equal(signatureLine("valid", "browser").text, "Signature valid (checked in your browser)");
  assert.match(signatureLine("valid", "server").text, /Signature checked by skilly/);
  assert.equal(signatureLine("revoked_key", "browser").text, "Signed by a revoked key: re-signing");
  assert.equal(signatureLine("invalid", "browser").tone, "danger");
});

test("statusNote: yanked and quarantined beside the verdict, nothing for active", () => {
  assert.equal(statusNote("yanked", "1.2.0", true), "Files are unchanged from v1.2.0, but this version was yanked.");
  assert.equal(statusNote("quarantined", "1.2.0", true), "Files are unchanged from v1.2.0, but this version was quarantined after a critical scan finding.");
  assert.equal(statusNote("yanked", "1.2.0", false), "v1.2.0 was yanked.");
  assert.equal(statusNote("active", "1.2.0", true), null);
});

test("movedNote and kindNote", async () => {
  const { resp, keys } = await fixture();
  const [base] = await checkStatements(resp, keys);
  assert.equal(movedNote(base!, "team-a", "deploy"), null);
  assert.equal(movedNote(base!, "team-b", "deploy"), "Signed as team-a/deploy (moved since)");
  assert.equal(kindNote("publish", "18/11/2026"), null);
  assert.equal(kindNote("backfill", "18/11/2026"), "Signed on 18/11/2026 from the files skilly held then. This version was published before signing existed.");
  assert.match(kindNote("resign", "18/11/2026")!, /^Re-signed on 18\/11\/2026/);
});

test("signatureBadge: Signed, Signed (backfill) with its tooltip, pending, revoked", () => {
  const date = () => "18/11/2026";
  const sig = { kind: "publish" as const, keyId: "abcd1234abcd1234", keyStatus: "active" as const, computedHash: H("c"), signedAt: "2026-11-18T10:00:00Z", variants: 0 };
  assert.equal(signatureBadge(sig, date).label, "Signed");
  const bf = signatureBadge({ ...sig, kind: "backfill" }, date);
  assert.equal(bf.label, "Signed (backfill)");
  assert.equal(bf.title, "Signed on 18/11/2026 from the files skilly held then. This version was published before signing existed.");
  assert.equal(signatureBadge(null, date).label, "Signature pending");
  assert.equal(signatureBadge({ ...sig, keyStatus: "revoked" }, date).label, "Signed by a revoked key: re-signing");
});

// ---------------------------------------------------------------------------
// Downloads, bundles, reports, installs
// ---------------------------------------------------------------------------

test("statement downloads: the version's own and a variant's, by the first 8 hex", () => {
  const v = { rewrites: ["deprecation" as const], inputsSha256: "0123456789" + "a".repeat(54) };
  assert.equal(statementDownloadUrl("team-a", "deploy", "1.2.0"), "/api/skills/team-a/deploy/versions/1.2.0/statement?download=1");
  assert.equal(statementDownloadUrl("team-a", "deploy", "1.2.0", v), "/api/skills/team-a/deploy/versions/1.2.0/statement?download=1&variant=01234567");
  assert.equal(statementFileName("deploy", "1.2.0"), "deploy-1.2.0.intoto.json");
  assert.equal(statementFileName("deploy", "1.2.0", v), "deploy-1.2.0.variant-01234567.intoto.json");
  assert.equal(variantName(v), "With skilly's deprecation notice");
});

test("bundleVerdict: compared with the version statement's artifactSha256", async () => {
  const { resp, keys, kp } = await fixture();
  const [base, dep] = await checkStatements(resp, keys);
  assert.equal(bundleVerdict(H("A"), base!), "match");
  assert.equal(bundleVerdict(H("b"), base!), "mismatch");
  assert.equal(bundleVerdict(H("a"), dep!), "no_hash", "a variant has no bundle");
  const legacy = await checkStatements({ ...resp, statements: [await signEntry(kp, FILES, { artifactSha256: null, hashRecordedAtPublish: false })] }, keys);
  assert.equal(bundleVerdict(H("a"), legacy[0]!), "no_hash");
  assert.match(bundleMessage("mismatch", "1.2.0").text, /extract it and verify the folder/);
  assert.equal(bundleMessage("match", "1.2.0").tone, "ok");
});

test("reportBody: paths, statuses and hashes only; the note trimmed and capped", async () => {
  const { resp, keys } = await fixture();
  const checked = await checkStatements(resp, keys);
  const edited = [{ path: "SKILL.md", bytes: enc("changed") }, { path: "notes.txt", bytes: enc("x") }];
  const { local, computedHash } = await hashFolder(edited);
  const out = decideVerification(local, computedHash, resp, checked);
  const body = reportBody(out.verdict, "  looks tampered  ");
  assert.equal(body.verdict, "changed");
  assert.equal(body.note, "looks tampered");
  for (const f of body.files) assert.deepEqual(Object.keys(f).sort(), f.status === "missing" ? ["path", "status"] : ["path", "sha256", "status"]);
  assert.deepEqual(body.files.map((f) => `${f.path}:${f.status}`), ["SKILL.md:modified", "notes.txt:extra", "scripts/run.sh:missing"]);
  assert.equal(reportBody(out.verdict, "   ").note, undefined);
  assert.equal(reportBody(out.verdict, "x".repeat(2500)).note!.length, 2000);
});

test("installVerifySemver: the pinned version, else the last served, else latest", () => {
  assert.equal(installVerifySemver({ pinnedSemver: "1.0.0", lastServedSemver: "1.0.0", latestSemver: "2.0.0" }), "1.0.0");
  assert.equal(installVerifySemver({ pinnedSemver: null, lastServedSemver: "1.4.0", latestSemver: "2.0.0" }), "1.4.0");
  assert.equal(installVerifySemver({ pinnedSemver: null, lastServedSemver: null, latestSemver: "2.0.0" }), "2.0.0");
  assert.equal(installVerifySemver({ pinnedSemver: null, lastServedSemver: null, latestSemver: null }), null);
});

// ---------------------------------------------------------------------------
// skills-lock.json
// ---------------------------------------------------------------------------

test("parseSkillsLock: a lock-v2 map keeps only names and hashes", () => {
  const r = parseSkillsLock(
    JSON.stringify({
      version: 2,
      skills: {
        deploy: { source: "x", sourceUrl: "https://x-access-token:SECRET@skilly.example.com/team-a/deploy.git#v1.2.0", computedHash: H("A") },
        lint: { sourceUrl: "https://example.com/lint.git" },
      },
    }),
  );
  assert.ok(r.ok);
  assert.equal(r.lockVersion, 2);
  assert.deepEqual(r.entries, [{ name: "deploy", computedHash: H("a") }, { name: "lint", computedHash: null }]);
  assert.ok(!JSON.stringify(r).includes("SECRET"), "nothing but names and hashes survives parsing");
});

test("parseSkillsLock: lock v1 has no hashes; arrays of entries work; bad input is refused", () => {
  const v1 = parseSkillsLock(JSON.stringify({ version: 1, skills: { deploy: { computedHash: H("a") } } }));
  assert.ok(v1.ok);
  assert.equal(v1.entries[0]!.computedHash, null);
  const arr = parseSkillsLock(JSON.stringify({ version: 2, skills: [{ name: "deploy", computedHash: H("b") }, { computedHash: "short" }] }));
  assert.ok(arr.ok);
  assert.deepEqual(arr.entries, [{ name: "deploy", computedHash: H("b") }, { name: "entry 2", computedHash: null }]);
  assert.equal(parseSkillsLock("{nope").ok, false);
  assert.equal(parseSkillsLock("[]").ok, false);
  assert.equal(parseSkillsLock(JSON.stringify({ version: 2 })).ok, false);
  assert.equal(parseSkillsLock(JSON.stringify({ version: 2, skills: {} })).ok, false);
  assert.match(NO_LOCK_HASH, /^No hash in this lock: run `npx skills install`/);
});

test("lockHashes and chunk: distinct hashes in lookup-sized calls", () => {
  assert.deepEqual(lockHashes([{ name: "a", computedHash: H("a") }, { name: "b", computedHash: null }, { name: "c", computedHash: H("a") }, { name: "d", computedHash: H("b") }]), [H("a"), H("b")]);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 200), []);
});

test("matchLabel: ns/slug@semver plus the variant's rewrites", () => {
  const m = { namespaceSlug: "team-a", skillSlug: "deploy", title: "Deploy", semver: "1.2.0", variant: null, status: "active" };
  assert.equal(matchLabel(m), "team-a/deploy@1.2.0");
  assert.equal(matchLabel({ ...m, variant: { rewrites: ["marketplace_hoist"], inputsSha256: H("e") } }), "team-a/deploy@1.2.0 (as delivered in a plugin marketplace)");
});

test("offlineRecipe: this registry and the active key filled into the §73.7 steps", () => {
  const r = offlineRecipe("https://skilly.example.com/", "0123456789abcdef");
  assert.match(r, /^KEYID=0123456789abcdef /);
  assert.ok(r.includes("curl -s https://skilly.example.com/.well-known/skilly-signing-keys.json \\"));
  assert.ok(r.includes(`{ printf 'DSSEv1 %d %s %d ' "\${#T}" "$T" "$(wc -c < payload.json)"; cat payload.json; } > pae.bin`));
  assert.ok(r.includes(`jq -r '.predicate.files[] | select(.installed) | "\\(.sha256)  \\(.path)"' payload.json > "$PWD/SHA256SUMS"`));
  assert.ok(r.includes("openssl pkeyutl -verify -pubin -inkey skilly.pem -rawin -in pae.bin -sigfile sig.bin"));
  assert.match(offlineRecipe("https://x", null), /^KEYID=\$\(jq -r '\.signatures\[0\]\.keyid' statement\.json\)/);
});
