// Live-DB integration test for signed skill versions on the web side (SKILLY_SPEC.md §73.15).
// Gated by SKILLY_DB_E2E=1:
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… node --import tsx --test src/lib/signing.dbtest.ts
//
// Statements are signed here exactly as the worker signs them (node:crypto Ed25519 over the DSSE
// PAE) with a throwaway key registered RETIRED, so the platform's active key is never touched and
// parallel test files never collide on "one active key". Covers: the statement payload (current
// statement, server signature, other versions), server-side verify (match, variant, changed, other
// version), the visibility-filtered hash lookup, the per-version badge data, agent sync's
// computedHash, revocation (final, reasoned, audited; statements then read revoked_key), mismatch
// reports (admin notification, audit, the 10/hour limit), and the migration's guards.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  DSSE_PAYLOAD_TYPE,
  buildSkillVersionStatement,
  describeLocalFiles,
  envelopeFromSignature,
  fingerprintFromSpki,
  keyIdFromSpki,
  paeBytes,
  resolveSigningRegistry,
  skillsLockComputedHash,
  variantFor,
  type SourceFile,
  type StatementVariant,
} from "@skilly/shared";
import { pool } from "./db";
import { invalidateAccessCaches, resolveUserAccessById } from "./access";
import { listVersions } from "./catalog";
import { listAgentSkills } from "./agentSync";
import {
  lookupHashes,
  recentReportCount,
  recordMismatchReport,
  revokeSigningKey,
  signingAdminView,
  statementPayload,
  verifyOnServer,
  publicKeysDocument,
} from "./signing";
import { findSkill } from "./catalog";

const enabled = process.env.SKILLY_DB_E2E === "1";
after(async () => {
  if (enabled) await pool.end();
});

const T = "signing71";
const enc = (s: string) => new TextEncoder().encode(s);
const one = async (sql: string, params: unknown[] = []) => (await pool.query<{ id: string }>(sql, params)).rows[0]!.id;
const mkUser = (oid: string) =>
  one(
    `insert into users (entra_object_id, email, display_name, status) values ($1, $1 || '@org.test', $1, 'active')
     on conflict (entra_object_id) do update set status = 'active', erased_at = null returning id`,
    [oid],
  );
const mkNs = (slug: string) =>
  one(`insert into namespaces (slug, display_name, require_review) values ($1, $1, true) on conflict (slug) do update set display_name = excluded.display_name returning id`, [slug]);
const mkGroup = (oid: string) =>
  one(`insert into groups (entra_object_id, display_name) values ($1, $1) on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`, [oid]);
const mkSkill = (ns: string, slug: string, visibility: "org" | "namespace") =>
  one(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
     values ($1, $2, 'Title ' || $2, 'desc', 'generic', 'hosted', $3, 'active')
     on conflict (namespace_id, slug) do update set visibility = excluded.visibility, status = 'active' returning id`,
    [ns, slug, visibility],
  );
const mkVersion = (skill: string, semver: string, actor: string, status = "active") =>
  one(
    `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
     values ($1::uuid, $2::text, false, $5::version_status, 'k/' || $1::uuid::text || '/' || $2::text, $3, $4, true)
     on conflict (skill_id, semver) do update set status = excluded.status returning id`,
    [skill, semver, "a".repeat(64), actor, status],
  );

interface TestKey {
  keyId: string;
  signEnvelope(payload: Uint8Array): { payloadType: string; payload: string; signatures: { keyid: string; sig: string }[] };
}

/** A throwaway key, registered RETIRED (trusted, never the active one). */
async function newKey(): Promise<TestKey> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const keyId = await keyIdFromSpki(der);
  await pool.query(`insert into signing_keys (key_id, public_key_pem, fingerprint, retired_at) values ($1, $2, $3, now())`, [
    keyId,
    publicKey.export({ type: "spki", format: "pem" }).toString(),
    await fingerprintFromSpki(der),
  ]);
  return {
    keyId,
    signEnvelope: (payload) => envelopeFromSignature(payload, keyId, new Uint8Array(sign(null, Buffer.from(paeBytes(DSSE_PAYLOAD_TYPE, payload)), privateKey))),
  };
}

/** Sign a file set for a version exactly as the worker does, and insert it. */
async function attest(key: TestKey, v: { versionId: string; skillId: string; ns: string; slug: string; semver: string }, files: SourceFile[], variant: StatementVariant | null = null, kind: "publish" | "backfill" = "publish") {
  const built = await buildSkillVersionStatement({
    registry: resolveSigningRegistry(process.env),
    skill: { id: v.skillId, namespace: v.ns, slug: v.slug },
    version: { id: v.versionId, semver: v.semver },
    variant,
    kind,
    hashRecordedAtPublish: true,
    source: { type: "hosted" },
    artifactSha256: "a".repeat(64),
    tagCommit: "b".repeat(40),
    signedAt: new Date().toISOString(),
    files,
  });
  await pool.query(
    `insert into skill_version_attestations (skill_version_id, variant_rewrites, variant_key, kind, key_id, computed_hash, envelope)
     values ($1, $2::text[], $3, $4, $5, $6, $7::jsonb)`,
    [v.versionId, variant?.rewrites ?? [], variant?.inputsSha256 ?? "", kind, key.keyId, built.computedHash, JSON.stringify(key.signEnvelope(built.payload))],
  );
  return built.computedHash;
}

test("signed versions (web): statements, verify, lookup, badge data, agent sync, revoke, reports, guards", { skip: !enabled }, async () => {
  // ── Fixtures ───────────────────────────────────────────────────────────────────────────────
  const run = randomBytes(4).toString("hex"); // per-run content, so hash lookups only see this run's rows
  const admin = await mkUser(`${T}-admin`);
  const member = await mkUser(`${T}-member`);
  const outsider = await mkUser(`${T}-outsider`);
  const nsA = await mkNs(`${T}-a`);
  const gMember = await mkGroup(`${T}-g-member`);
  const gAdmin = await mkGroup(`${T}-g-admin`);
  await pool.query(`insert into role_mappings (group_id, namespace_id, role) values ($1, $2, 'namespace_member') on conflict do nothing`, [gMember, nsA]);
  await pool.query(
    `insert into role_mappings (group_id, namespace_id, role) select $1, null, 'platform_admin'
      where not exists (select 1 from role_mappings where group_id = $1 and role = 'platform_admin')`,
    [gAdmin],
  );
  await pool.query(`insert into group_memberships (group_id, user_id) values ($1, $2), ($3, $4) on conflict do nothing`, [gMember, member, gAdmin, admin]);
  invalidateAccessCaches();

  const slug = `${T}-${run}`;
  const restricted = await mkSkill(nsA, slug, "namespace");
  const v1 = await mkVersion(restricted, "1.0.0", admin);
  const v2 = await mkVersion(restricted, "1.1.0", admin);
  const v3 = await mkVersion(restricted, "1.2.0", admin, "yanked");
  const filesV1: SourceFile[] = [{ path: "SKILL.md", bytes: enc(`---\nname: ${slug}\n---\n# v1 ${run}\n`) }, { path: "scripts/run.sh", bytes: enc("echo hi\r\n"), mode: "100755" }];
  const filesV2: SourceFile[] = [{ path: "SKILL.md", bytes: enc(`---\nname: ${slug}\n---\n# v2 ${run}\n`) }];
  const hinted: SourceFile[] = [{ path: "SKILL.md", bytes: enc(`---\nname: ${slug}\ndescription: DEPRECATED\n---\n# v2 ${run}\n`) }];

  const key = await newKey();
  const ids = (versionId: string, semver: string) => ({ versionId, skillId: restricted, ns: `${T}-a`, slug, semver });
  const hashV1 = await attest(key, ids(v1, "1.0.0"), filesV1);
  const hashV2 = await attest(key, ids(v2, "1.1.0"), filesV2);
  const variant = await variantFor(["deprecation"], { successor: null, note: run, successorUrl: null });
  const hashHint = await attest(key, ids(v2, "1.1.0"), hinted, variant);
  await attest(key, ids(v3, "1.2.0"), filesV2.map((f) => ({ ...f, bytes: enc(`---\nname: ${slug}\n---\n# v3 ${run}\n`) })), null, "backfill");
  assert.equal(hashV1, await skillsLockComputedHash(filesV1));

  // ── The statement payload (§73.10) ────────────────────────────────────────────────────────
  const p2 = (await statementPayload(restricted, "1.1.0"))!.payload;
  assert.equal(p2.statements.length, 2, "the version's statement and its variant");
  assert.equal(p2.statements[0]!.variant, null, "the version's own statement comes first");
  assert.deepEqual(p2.statements[1]!.variant, variant);
  assert.ok(p2.statements.every((s) => s.serverSignature === "valid" && s.keyStatus === "retired"));
  assert.deepEqual(p2.otherVersions.map((o) => o.semver).sort(), ["1.0.0", "1.2.0"]);
  assert.equal(p2.otherVersions.find((o) => o.semver === "1.0.0")!.computedHash, hashV1);
  assert.equal(await statementPayload(restricted, "9.9.9"), null);

  // ── Server-side verify ─────────────────────────────────────────────────────────────────────
  const exact = await verifyOnServer(restricted, "1.0.0", await describeLocalFiles(filesV1));
  assert.ok(exact && exact !== "pending");
  assert.equal(exact.overall, "match");
  assert.equal(exact.signature, "valid");
  const lf = await verifyOnServer(restricted, "1.0.0", await describeLocalFiles([filesV1[0]!, { path: "scripts/run.sh", bytes: enc("echo hi\n") }]));
  assert.ok(lf && lf !== "pending" && lf.overall === "match" && lf.counts.line_endings === 1, "CRLF→LF only is still a match");
  const viaVariant = await verifyOnServer(restricted, "1.1.0", await describeLocalFiles(hinted));
  assert.ok(viaVariant && viaVariant !== "pending");
  assert.deepEqual(viaVariant.variant, variant);
  const other = await verifyOnServer(restricted, "1.1.0", await describeLocalFiles(filesV1));
  assert.ok(other && other !== "pending");
  assert.equal(other.overall, "match_other_version");
  assert.equal(other.otherVersion, "1.0.0");
  const changed = await verifyOnServer(restricted, "1.1.0", await describeLocalFiles([{ path: "SKILL.md", bytes: enc("tampered") }, { path: ".DS_Store", bytes: enc("x") }]));
  assert.ok(changed && changed !== "pending");
  assert.equal(changed.overall, "changed");
  assert.equal(changed.files.find((f) => f.path === ".DS_Store")!.osMetadata, true);

  // ── Lookup is visibility-filtered (invariant #3) ───────────────────────────────────────────
  const memberAccess = await resolveUserAccessById(member);
  const outsiderAccess = await resolveUserAccessById(outsider);
  const seen = await lookupHashes(memberAccess, [hashV1, hashHint]);
  assert.equal(seen[0]!.matches.length, 1);
  assert.equal(seen[0]!.matches[0]!.semver, "1.0.0");
  assert.deepEqual(seen[1]!.matches[0]!.variant, variant);
  const hidden = await lookupHashes(outsiderAccess, [hashV1, hashHint]);
  assert.ok(hidden.every((r) => r.matches.length === 0), "a restricted skill's hash never matches for someone outside it");

  // ── The badge data and agent sync's hash ───────────────────────────────────────────────────
  const versions = await listVersions(restricted);
  const byVer = new Map(versions.map((v) => [v.semver, v]));
  assert.equal(byVer.get("1.1.0")!.signature!.computedHash, hashV2);
  assert.equal(byVer.get("1.1.0")!.signature!.variants, 1);
  assert.equal(byVer.get("1.2.0")!.signature!.kind, "backfill");
  const synced = await listAgentSkills(memberAccess, "https://skilly.test");
  const mine = synced.skills.find((s) => s.slug === slug)!;
  assert.equal(mine.version, "1.1.0");
  assert.equal(mine.computedHash, hashV2);
  assert.equal(mine.statementUrl, `https://skilly.test/${T}-a/${slug}.git/skilly/statement/v1.1.0`);

  // ── Public keys document: keys only ────────────────────────────────────────────────────────
  const doc = await publicKeysDocument();
  const k = doc.keys.find((x) => x.keyId === key.keyId)!;
  assert.match(k.publicKeyPem, /BEGIN PUBLIC KEY/);
  assert.equal("revokedReason" in k, false);

  // ── Mismatch reports: admins notified, audited, 10/hour ────────────────────────────────────
  const skillRow = (await findSkill(`${T}-a`, slug))!;
  const before = await recentReportCount(member);
  await recordMismatchReport({ ...memberAccess, userId: member }, skillRow, "1.1.0", { files: [{ path: "SKILL.md", status: "modified", sha256: "c".repeat(64) }], note: `note ${run}`, verdict: "changed" });
  assert.equal(await recentReportCount(member), before + 1);
  const note = await pool.query<{ payload: Record<string, unknown> }>(
    `select payload from notifications where user_id = $1 and type = 'skill.signature_mismatch' and payload->>'note' = $2`,
    [admin, `note ${run}`],
  );
  assert.equal(note.rowCount, 1, "the platform admin is notified");
  assert.equal(note.rows[0]!.payload.modified, 1);
  assert.equal(note.rows[0]!.payload.reporterName, `${T}-member`);
  const maintainerNote = await pool.query(`select 1 from notifications where user_id = $1 and type = 'skill.signature_mismatch' and payload->>'note' = $2`, [member, `note ${run}`]);
  assert.equal(maintainerNote.rowCount, 0, "the reporter (not an admin) is not notified");
  const view = await signingAdminView();
  assert.ok(view.reports.some((r) => r.note === `note ${run}`));

  // ── Revocation: final, reasoned, audited; statements then read revoked_key ─────────────────
  assert.deepEqual(await revokeSigningKey(admin, key.keyId, "  "), { ok: false, status: 422, error: "a reason is required" });
  const revoked = await revokeSigningKey(admin, key.keyId, `test revocation ${run}`);
  assert.ok(revoked.ok && revoked.affected === 4, "v1, v2, v2's variant and v3");
  assert.deepEqual(await revokeSigningKey(admin, key.keyId, "again"), { ok: false, status: 409, error: "this key is already revoked" });
  const audit = await pool.query(`select 1 from audit_log where action = 'signing.key_revoked' and target_id = $1`, [key.keyId]);
  assert.equal(audit.rowCount, 1);
  const afterRevoke = (await statementPayload(restricted, "1.0.0"))!.payload;
  assert.equal(afterRevoke.statements[0]!.keyStatus, "revoked");
  assert.equal(afterRevoke.statements[0]!.serverSignature, "revoked_key");
  await assert.rejects(pool.query(`update signing_keys set revoked_at = null, revoked_reason = null where key_id = $1`, [key.keyId]), /final/);

  // A re-sign by another key becomes the current statement again.
  const key2 = await newKey();
  await attest(key2, ids(v1, "1.0.0"), filesV1, null, "publish");
  const resigned = (await statementPayload(restricted, "1.0.0"))!.payload;
  assert.equal(resigned.statements[0]!.keyId, key2.keyId);
  assert.equal(resigned.statements[0]!.serverSignature, "valid");

  // ── Migration guards ───────────────────────────────────────────────────────────────────────
  await assert.rejects(pool.query(`update skill_version_attestations set kind = 'resign' where key_id = $1`, [key2.keyId]), /append-only|immutable/);
  await assert.rejects(pool.query(`update signing_keys set public_key_pem = 'x' where key_id = $1`, [key2.keyId]), /immutable/);
  await assert.rejects(pool.query(`delete from signing_keys where key_id = $1`, [key2.keyId]), /never deleted|permission denied/);
  // At most one active key — checked inside a rolled-back transaction so the real key is untouched.
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`update signing_keys set retired_at = now() where retired_at is null and revoked_at is null`);
    await client.query(`update signing_keys set retired_at = null where key_id = $1`, [key2.keyId]);
    const third = await newKeyIn(client);
    await assert.rejects(client.query(`update signing_keys set retired_at = null where key_id = $1`, [third]), /signing_keys_one_active|duplicate key/);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
});

async function newKeyIn(db: { query: (sql: string, params: unknown[]) => Promise<unknown> }): Promise<string> {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const keyId = await keyIdFromSpki(der);
  await db.query(`insert into signing_keys (key_id, public_key_pem, fingerprint, retired_at) values ($1, $2, $3, now())`, [
    keyId,
    publicKey.export({ type: "spki", format: "pem" }).toString(),
    await fingerprintFromSpki(der),
  ]);
  return keyId;
}
