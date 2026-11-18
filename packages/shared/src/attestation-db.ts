// Signed-statement reads (SKILLY_SPEC.md §73), shared by web (REST + pages) and worker (the git-host
// route + MCP `list_skill_files`) so "the current statement" is decided once. Plain SQL over a
// minimal query interface; no pg import. NOT client-safe (barrel only).
import type { EffectiveAccess } from "./rbac.js";
import { skillVisibilityWhere } from "./visibility.js";
import {
  checkEnvelopeSignature,
  compareFiles,
  decodeEnvelope,
  verifyAgainstStatement,
  type AttestationKind,
  type DsseEnvelope,
  type LocalFile,
  type PublicSigningKey,
  type StatementVariant,
  type VariantRewrite,
  type Verdict,
  type VerifyCandidate,
} from "./attestation.js";

export interface AttestationDb {
  query(text: string, params?: any[]): Promise<{ rows: any[] }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export type KeyStatus = "active" | "retired" | "revoked";

export interface StatementRecord {
  variant: StatementVariant | null;
  kind: AttestationKind;
  keyId: string;
  keyStatus: KeyStatus;
  signedAt: string;
  computedHash: string;
  envelope: DsseEnvelope;
}

export interface OtherVersionHash {
  semver: string;
  status: string;
  computedHash: string;
}

export interface VersionStatements {
  versionId: string;
  semver: string;
  status: string;
  /** The current statement for the version, then one per variant, newest first. */
  statements: StatementRecord[];
  /** The other versions of the same skill with a statement — for "these files are vX" (§73.7). */
  otherVersions: OtherVersionHash[];
}

export interface PublicKeyRecord {
  keyId: string;
  algorithm: "ed25519";
  publicKeyPem: string;
  fingerprint: string;
  createdAt: string;
  retiredAt: string | null;
  revokedAt: string | null;
}

interface AttRow {
  skill_version_id: string;
  variant_rewrites: string[];
  variant_key: string;
  kind: AttestationKind;
  key_id: string;
  computed_hash: string;
  envelope: DsseEnvelope;
  created_at: Date | string;
  retired_at: Date | string | null;
  revoked_at: Date | string | null;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());

function keyStatus(r: Pick<AttRow, "retired_at" | "revoked_at">): KeyStatus {
  return r.revoked_at ? "revoked" : r.retired_at ? "retired" : "active";
}

/**
 * The current row per variant: the newest row whose key is not revoked; failing that, the newest
 * row (served as revoked_key until the re-sign sweep replaces it). Input: rows of ONE version.
 */
export function currentPerVariant<T extends Pick<AttRow, "variant_key" | "revoked_at" | "created_at">>(rows: readonly T[]): T[] {
  const byKey = new Map<string, T[]>();
  for (const r of rows) {
    const list = byKey.get(r.variant_key) ?? [];
    list.push(r);
    byKey.set(r.variant_key, list);
  }
  const out: T[] = [];
  for (const list of byKey.values()) {
    const sorted = [...list].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    out.push(sorted.find((r) => !r.revoked_at) ?? sorted[0]!);
  }
  // The version's own statement first, then variants newest first.
  return out.sort((a, b) => (a.variant_key === "" ? -1 : b.variant_key === "" ? 1 : new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
}

function toRecord(r: AttRow): StatementRecord {
  return {
    variant: r.variant_key ? { rewrites: [...r.variant_rewrites].sort() as VariantRewrite[], inputsSha256: r.variant_key } : null,
    kind: r.kind,
    keyId: r.key_id,
    keyStatus: keyStatus(r),
    signedAt: iso(r.created_at)!,
    computedHash: r.computed_hash,
    envelope: r.envelope,
  };
}

const ATT_COLUMNS = `a.skill_version_id, a.variant_rewrites, a.variant_key, a.kind, a.key_id, a.computed_hash, a.envelope,
                     a.created_at, k.retired_at, k.revoked_at`;

/**
 * A version's statements, by skill id + semver (the caller has already checked visibility).
 * Null when the version does not exist.
 */
export async function loadVersionStatements(db: AttestationDb, skillId: string, semver: string): Promise<VersionStatements | null> {
  const { rows: vrows } = await db.query(`select id, semver, status from skill_versions where skill_id = $1 and semver = $2`, [skillId, semver]);
  const v = vrows[0] as { id: string; semver: string; status: string } | undefined;
  if (!v) return null;
  const { rows } = await db.query(
    `select ${ATT_COLUMNS}, sv.semver, sv.status as version_status
       from skill_version_attestations a
       join signing_keys k on k.key_id = a.key_id
       join skill_versions sv on sv.id = a.skill_version_id
      where sv.skill_id = $1`,
    [skillId],
  );
  const all = rows as (AttRow & { semver: string; version_status: string })[];
  const mine = all.filter((r) => r.skill_version_id === v.id);
  const others = new Map<string, (AttRow & { semver: string; version_status: string })[]>();
  for (const r of all) {
    if (r.skill_version_id === v.id || r.variant_key !== "") continue;
    const list = others.get(r.skill_version_id) ?? [];
    list.push(r);
    others.set(r.skill_version_id, list);
  }
  const otherVersions: OtherVersionHash[] = [];
  for (const list of others.values()) {
    const cur = currentPerVariant(list)[0];
    if (cur) otherVersions.push({ semver: cur.semver, status: cur.version_status, computedHash: cur.computed_hash });
  }
  return {
    versionId: v.id,
    semver: v.semver,
    status: v.status,
    statements: currentPerVariant(mine).map(toRecord),
    otherVersions,
  };
}

/** Every key the platform has used, for /.well-known/skilly-signing-keys.json and verifiers. */
export async function loadPublicSigningKeys(db: AttestationDb): Promise<PublicKeyRecord[]> {
  const { rows } = await db.query(
    `select key_id, algorithm, public_key_pem, fingerprint, created_at, retired_at, revoked_at from signing_keys order by created_at`,
  );
  return rows.map((r: { key_id: string; public_key_pem: string; fingerprint: string; created_at: Date; retired_at: Date | null; revoked_at: Date | null }) => ({
    keyId: r.key_id,
    algorithm: "ed25519" as const,
    publicKeyPem: r.public_key_pem,
    fingerprint: r.fingerprint,
    createdAt: iso(r.created_at)!,
    retiredAt: iso(r.retired_at),
    revokedAt: iso(r.revoked_at),
  }));
}

/** The verifier's view of the keys (keyId, PEM, revoked). */
export function verifierKeys(keys: readonly PublicKeyRecord[]): PublicSigningKey[] {
  return keys.map((k) => ({ keyId: k.keyId, publicKeyPem: k.publicKeyPem, revokedAt: k.revokedAt }));
}

export interface HashMatch {
  namespaceSlug: string;
  skillSlug: string;
  title: string;
  semver: string;
  variant: StatementVariant | null;
  status: string;
}

/**
 * `POST /api/verify/lookup` (§73.10): which versions the caller can SEE have exactly these files, by
 * the installer-compatible computedHash. Archived skills never match; a hidden skill never appears.
 */
export async function lookupByComputedHash(
  db: AttestationDb,
  access: Pick<EffectiveAccess, "isPlatformAdmin" | "namespaceRoles">,
  hashes: readonly string[],
): Promise<Map<string, HashMatch[]>> {
  const want = [...new Set(hashes.map((h) => h.toLowerCase()))];
  const out = new Map<string, HashMatch[]>(want.map((h) => [h, []]));
  if (want.length === 0) return out;
  const params: unknown[] = [want];
  const where = ["a.computed_hash = any($1::text[])", "s.status = 'active'"];
  const vis = skillVisibilityWhere(access, params, "s");
  if (vis) where.push(vis);
  const { rows } = await db.query(
    `select distinct on (a.computed_hash, sv.id, a.variant_key)
            a.computed_hash, a.variant_key, a.variant_rewrites, sv.semver, sv.status,
            n.slug as ns_slug, s.slug as skill_slug, s.title, sv.created_at
       from skill_version_attestations a
       join skill_versions sv on sv.id = a.skill_version_id
       join skills s on s.id = sv.skill_id
       join namespaces n on n.id = s.namespace_id
      where ${where.join(" and ")}
      order by a.computed_hash, sv.id, a.variant_key`,
    params,
  );
  for (const r of rows as { computed_hash: string; variant_key: string; variant_rewrites: string[]; semver: string; status: string; ns_slug: string; skill_slug: string; title: string }[]) {
    out.get(r.computed_hash)?.push({
      namespaceSlug: r.ns_slug,
      skillSlug: r.skill_slug,
      title: r.title,
      semver: r.semver,
      variant: r.variant_key ? { rewrites: [...r.variant_rewrites].sort() as VariantRewrite[], inputsSha256: r.variant_key } : null,
      status: r.status,
    });
  }
  return out;
}

export interface ServerVerdict extends Verdict {
  semver: string;
  status: string;
  /** Always "skilly" here: the signature was checked on the server (§73.7). */
  checkedBy: "skilly";
}

/**
 * The §73.7 verdict computed on the server, for REST `POST …/verify` and MCP `list_skill_files`
 * with `local`: every current statement's signature is checked against the platform keys, then the
 * caller's hashes are compared — first with the version, then its variants, then (on no match)
 * the skill's other versions.
 */
export async function verifyFilesServerSide(
  db: AttestationDb,
  skillId: string,
  vs: VersionStatements,
  local: readonly LocalFile[],
  registry: string,
): Promise<ServerVerdict> {
  const keys = verifierKeys(await loadPublicSigningKeys(db));
  const candidates: VerifyCandidate[] = [];
  for (const st of vs.statements) {
    const decoded = decodeEnvelope(st.envelope);
    if (!decoded) continue;
    candidates.push({ variant: st.variant, files: decoded.statement.predicate.files, signature: await checkEnvelopeSignature(decoded, keys, registry) });
  }
  let verdict = verifyAgainstStatement(local, candidates);
  if (verdict.overall !== "match") {
    const other = await findOtherVersionByFiles(db, skillId, vs.versionId, local);
    if (other) verdict = verifyAgainstStatement(local, candidates, { otherVersionSemver: other });
  }
  return { ...verdict, semver: vs.semver, status: vs.status, checkedBy: "skilly" };
}

/**
 * REST/MCP verify (hashes only, so no computedHash): the other version of the same skill whose
 * current statement these files match, if any — newest version first.
 */
export async function findOtherVersionByFiles(db: AttestationDb, skillId: string, excludeVersionId: string, local: readonly LocalFile[]): Promise<string | null> {
  const { rows } = await db.query(
    `select ${ATT_COLUMNS}, sv.semver
       from skill_version_attestations a
       join signing_keys k on k.key_id = a.key_id
       join skill_versions sv on sv.id = a.skill_version_id
      where sv.skill_id = $1 and sv.id <> $2 and a.variant_key = ''
      order by sv.created_at desc, a.created_at desc`,
    [skillId, excludeVersionId],
  );
  const seen = new Set<string>();
  for (const r of rows as (AttRow & { semver: string })[]) {
    if (seen.has(r.skill_version_id)) continue;
    seen.add(r.skill_version_id);
    const decoded = decodeEnvelope(r.envelope);
    if (decoded && compareFiles(local, decoded.statement.predicate.files).matches) return r.semver;
  }
  return null;
}
