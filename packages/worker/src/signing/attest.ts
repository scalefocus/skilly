// Making signed statements (SKILLY_SPEC.md §73.3, §73.5, §73.6): build the in-toto statement for a
// served file set, sign it with the platform key, insert it append-only.
import type { Pool, PoolClient } from "pg";
import {
  buildSkillVersionStatement,
  envelopeFromSignature,
  resolveSigningRegistry,
  variantFor,
  type AttestationKind,
  type DeprecationInputs,
  type SourceFile,
  type StatementSource,
  type StatementVariant,
  type VariantRewrite,
} from "@skilly/shared";
import type { Signer } from "./key.js";
import { readCommitFiles } from "../git/synth.js";

type Db = Pool | PoolClient;

export interface VersionIdentity {
  versionId: string;
  skillId: string;
  nsSlug: string;
  skillSlug: string;
  semver: string;
  artifactSha256: string | null;
  source: StatementSource;
}

/** Everything a statement says about a version, read fresh (namespace = the owner now). */
export async function loadVersionIdentity(db: Db, versionId: string): Promise<VersionIdentity | null> {
  const { rows } = await db.query<{
    id: string; skill_id: string; ns_slug: string; skill_slug: string; semver: string; artifact_sha256: string | null;
    external_origin_url: string | null; external_ref: string | null; external_subdir: string | null; external_commit: string | null;
  }>(
    `select sv.id, sv.skill_id, n.slug as ns_slug, s.slug as skill_slug, sv.semver, sv.artifact_sha256,
            sv.external_origin_url, sv.external_ref, sv.external_subdir, sv.external_commit
       from skill_versions sv
       join skills s on s.id = sv.skill_id
       join namespaces n on n.id = s.namespace_id
      where sv.id = $1`,
    [versionId],
  );
  const r = rows[0];
  if (!r) return null;
  const source: StatementSource = r.external_origin_url
    ? { type: "pointer", origin: r.external_origin_url, ref: r.external_ref ?? "", subdir: r.external_subdir ?? null, commit: r.external_commit ?? null }
    : { type: "hosted" };
  return { versionId: r.id, skillId: r.skill_id, nsSlug: r.ns_slug, skillSlug: r.skill_slug, semver: r.semver, artifactSha256: r.artifact_sha256, source };
}

export interface AttestInput {
  identity: VersionIdentity;
  files: readonly SourceFile[];
  variant: StatementVariant | null;
  kind: AttestationKind;
  tagCommit: string | null;
}

/**
 * Build, sign and insert one statement. Idempotent per (version, variant, key): a second call with
 * the same key inserts nothing. Throws when signing or the insert fails — callers fail closed.
 */
export async function insertAttestation(db: Db, signer: Signer, input: AttestInput): Promise<{ computedHash: string; inserted: boolean }> {
  const { identity: id } = input;
  const built = await buildSkillVersionStatement({
    registry: resolveSigningRegistry(process.env),
    skill: { id: id.skillId, namespace: id.nsSlug, slug: id.skillSlug },
    version: { id: id.versionId, semver: id.semver },
    variant: input.variant,
    kind: input.kind,
    hashRecordedAtPublish: id.artifactSha256 !== null,
    source: id.source,
    artifactSha256: id.artifactSha256,
    tagCommit: input.tagCommit,
    signedAt: new Date().toISOString(),
    files: input.files,
  });
  const envelope = envelopeFromSignature(built.payload, signer.keyId, signer.signPayload(built.payload));
  const { rowCount } = await db.query(
    `insert into skill_version_attestations (skill_version_id, variant_rewrites, variant_key, kind, key_id, computed_hash, envelope)
     values ($1, $2::text[], $3, $4, $5, $6, $7::jsonb)
     on conflict (skill_version_id, variant_key, key_id) do nothing`,
    [id.versionId, input.variant?.rewrites ?? [], input.variant?.inputsSha256 ?? "", input.kind, signer.keyId, built.computedHash, JSON.stringify(envelope)],
  );
  return { computedHash: built.computedHash, inserted: (rowCount ?? 0) > 0 };
}

export interface AttestationState {
  /** A statement by a non-revoked key exists. */
  current: boolean;
  /** Some statement exists, but only by revoked keys (so the next one is a re-sign). */
  revokedOnly: boolean;
  /** The kind of the version's own current statement, if any (variants inherit it). */
  baseKind: AttestationKind | null;
}

export async function attestationState(db: Db, versionId: string, variantKey: string): Promise<AttestationState> {
  const { rows } = await db.query<{ variant_key: string; kind: AttestationKind; revoked: boolean }>(
    `select a.variant_key, a.kind, (k.revoked_at is not null) as revoked
       from skill_version_attestations a join signing_keys k on k.key_id = a.key_id
      where a.skill_version_id = $1 and a.variant_key in ($2, '')
      order by a.created_at desc`,
    [versionId, variantKey],
  );
  const mine = rows.filter((r) => r.variant_key === variantKey);
  const base = rows.find((r) => r.variant_key === "" && !r.revoked);
  return {
    current: mine.some((r) => !r.revoked),
    revokedOnly: mine.length > 0 && mine.every((r) => r.revoked),
    baseKind: base ? (base.kind === "resign" ? "publish" : base.kind) : null,
  };
}

/**
 * Sign a variant (a skilly-made rewrite, §73.5) unless a current statement already exists. Its kind:
 * `resign` after a revocation, else the version statement's (`backfill` while the version has none).
 */
export async function ensureVariantAttestation(
  db: Db,
  signer: Signer,
  args: { versionId: string; variant: StatementVariant; files: () => Promise<readonly SourceFile[]>; tagCommit: string | null },
): Promise<"present" | "signed"> {
  const state = await attestationState(db, args.versionId, args.variant.inputsSha256);
  if (state.current) return "present";
  if (!(await signer.usable())) throw new Error("signing key is not usable (revoked or unregistered)");
  const identity = await loadVersionIdentity(db, args.versionId);
  if (!identity) throw new Error(`version ${args.versionId} not found`);
  const kind: AttestationKind = state.revokedOnly ? "resign" : state.baseKind ?? "backfill";
  await insertAttestation(db, signer, { identity, files: await args.files(), variant: args.variant, kind, tagCommit: args.tagCommit });
  return "signed";
}

/** The deprecation inputs as the variant identity reads them. */
export function deprecationInputs(state: { successor: string | null; note: string | null; successorUrl: string | null }): DeprecationInputs {
  return { successor: state.successor, note: state.note, successorUrl: state.successorUrl };
}

export async function variantOf(rewrites: readonly VariantRewrite[], dep: DeprecationInputs | null): Promise<StatementVariant> {
  return variantFor(rewrites, dep);
}

/**
 * The hook `ensureMain` calls before it serves a deprecation commit on `main` (§45.4, §73.5): sign
 * the commit's files as the `deprecation` variant of the latest-stable version. Throws on failure,
 * so `main` is left where it was.
 */
export function deprecationHintSigner(
  pool: Pool,
  signer: Signer,
  args: { skillId: string; semver: string; bareRepoPath: string; state: DeprecationInputs },
): (hintCommit: string, tagCommit: string) => Promise<void> {
  return async (hintCommit, tagCommit) => {
    const { rows } = await pool.query<{ id: string }>(`select id from skill_versions where skill_id = $1 and semver = $2`, [args.skillId, args.semver]);
    const versionId = rows[0]?.id;
    if (!versionId) throw new Error(`version ${args.semver} of skill ${args.skillId} not found`);
    const variant = await variantFor(["deprecation"], args.state);
    await ensureVariantAttestation(pool, signer, {
      versionId,
      variant,
      files: () => readCommitFiles(args.bareRepoPath, hintCommit),
      tagCommit,
    });
  };
}
