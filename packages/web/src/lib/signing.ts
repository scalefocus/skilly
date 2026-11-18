// Signed skill versions on the web side (SKILLY_SPEC.md §73): statements, server-side verify, the
// lookup behind /verify, mismatch reports and the Administration → Signing page. Web never holds a
// private key; it reads public keys and statements the worker wrote.
import type { EffectiveAccess as SharedAccess } from "@skilly/shared";
import {
  checkEnvelopeSignature,
  decodeEnvelope,
  verifierKeys,
  type SignatureStatus,
  formatFingerprint,
  isSha256Hex,
  isSkillVisible,
  isValidSemver,
  loadPublicSigningKeys,
  loadVersionStatements,
  lookupByComputedHash,
  resolveSigningRegistry,
  verifyFilesServerSide,
  type HashMatch,
  type LocalFile,
  type PublicKeyRecord,
  type ServerVerdict,
  type VersionStatements,
} from "@skilly/shared";
import { pool } from "./db";
import { findSkill } from "./catalog";
import { canManageMaintainers } from "./maintainers";
import { appendAudit } from "./audit";
import { recordSystemEvent } from "./systemLog";

/** The resolved session access (lib/access.ts). */
type EffectiveAccess = SharedAccess & { userId: string | null };

export const MAX_LOOKUP_HASHES = 200;
export const MAX_REPORT_NOTE = 2000;
export const REPORTS_PER_HOUR = 10;

export function signingRegistry(): string {
  return resolveSigningRegistry(process.env);
}

type FoundSkill = NonNullable<Awaited<ReturnType<typeof findSkill>>>;

/**
 * The skill behind a version-scoped route, after the visibility check (invariant #3): archived
 * skills only for their owners, anything hidden is the same "not found" as a missing one.
 */
export async function visibleSkillForVersion(access: EffectiveAccess, ns: string, slug: string, semver: string): Promise<FoundSkill | null> {
  if (!isValidSemver(semver) || !access.userId) return null;
  const skill = await findSkill(ns, slug);
  if (!skill) return null;
  if (skill.status === "archived") {
    return (await canManageMaintainers(access, skill, access.userId)) ? skill : null;
  }
  return isSkillVisible(access, skill) ? skill : null;
}

export interface StatementPayload {
  registry: string;
  semver: string;
  status: string;
  /** Each current statement, plus the signature status skilly computed for it. */
  statements: (VersionStatements["statements"][number] & { serverSignature: SignatureStatus })[];
  otherVersions: VersionStatements["otherVersions"];
}

/** The REST `GET …/statement` body (§73.10); null when the version doesn't exist. */
export async function statementPayload(skillId: string, semver: string): Promise<{ payload: StatementPayload; versionId: string } | null> {
  const vs = await loadVersionStatements(pool, skillId, semver);
  if (!vs) return null;
  const registry = signingRegistry();
  const keys = verifierKeys(await loadPublicSigningKeys(pool));
  const statements: StatementPayload["statements"] = [];
  for (const st of vs.statements) {
    const decoded = decodeEnvelope(st.envelope);
    statements.push({ ...st, serverSignature: decoded ? await checkEnvelopeSignature(decoded, keys, registry) : "invalid" });
  }
  return {
    versionId: vs.versionId,
    payload: { registry, semver: vs.semver, status: vs.status, statements, otherVersions: vs.otherVersions },
  };
}

/** Server-side verdict for REST `POST …/verify` (§73.10). Null = no such version. */
export async function verifyOnServer(skillId: string, semver: string, local: readonly LocalFile[]): Promise<ServerVerdict | "pending" | null> {
  const vs = await loadVersionStatements(pool, skillId, semver);
  if (!vs) return null;
  if (vs.statements.length === 0) return "pending";
  return verifyFilesServerSide(pool, skillId, vs, local, signingRegistry());
}

/** `POST /api/verify/lookup`: validate, then the visibility-filtered matches. */
export function parseLookupHashes(raw: unknown): string[] | string {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { hashes?: unknown }).hashes)) return "hashes must be an array of sha256 hex strings";
  const hashes = (raw as { hashes: unknown[] }).hashes;
  if (hashes.length === 0) return "hashes must not be empty";
  if (hashes.length > MAX_LOOKUP_HASHES) return `at most ${MAX_LOOKUP_HASHES} hashes`;
  if (!hashes.every(isSha256Hex)) return "each hash must be 64 hex characters";
  return (hashes as string[]).map((h) => h.toLowerCase());
}

export async function lookupHashes(access: EffectiveAccess, hashes: readonly string[]): Promise<{ computedHash: string; matches: HashMatch[] }[]> {
  const found = await lookupByComputedHash(pool, access, hashes);
  return hashes.map((h) => ({ computedHash: h, matches: found.get(h) ?? [] }));
}

export async function publicKeysDocument(): Promise<{ registry: string; keys: Omit<PublicKeyRecord, never>[] }> {
  return { registry: signingRegistry(), keys: await loadPublicSigningKeys(pool) };
}

// ---------------------------------------------------------------------------
// Mismatch reports (§73.11)
// ---------------------------------------------------------------------------

const REPORT_STATUSES = new Set(["modified", "missing", "extra", "line_endings", "unchanged"]);

export interface MismatchReportFile {
  path: string;
  status: string;
  sha256?: string;
}

export function parseMismatchReport(raw: unknown): { files: MismatchReportFile[]; note: string | null; verdict: string } | string {
  if (!raw || typeof raw !== "object") return "body must be an object";
  const b = raw as { files?: unknown; note?: unknown; verdict?: unknown };
  if (!Array.isArray(b.files) || b.files.length === 0) return "files must be a non-empty array of { path, status, sha256? }";
  if (b.files.length > 5000) return "at most 5000 files";
  const files: MismatchReportFile[] = [];
  for (const f of b.files) {
    if (!f || typeof f !== "object") return "each file must be an object";
    const { path, status, sha256 } = f as Record<string, unknown>;
    if (typeof path !== "string" || !path || path.length > 1024) return "each file needs a path";
    if (typeof status !== "string" || !REPORT_STATUSES.has(status)) return "status must be unchanged, line_endings, modified, missing or extra";
    if (sha256 !== undefined && !isSha256Hex(sha256)) return "sha256 must be 64 hex characters";
    files.push({ path, status, ...(typeof sha256 === "string" ? { sha256: sha256.toLowerCase() } : {}) });
  }
  if (b.note !== undefined && b.note !== null && typeof b.note !== "string") return "note must be a string";
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (note.length > MAX_REPORT_NOTE) return `note must be at most ${MAX_REPORT_NOTE} characters`;
  const verdict = b.verdict === "match_other_version" ? "match_other_version" : "changed";
  return { files, note: note || null, verdict };
}

/** Counts by status, for the audit row and the notification body. */
export function reportCounts(files: readonly MismatchReportFile[]): Record<string, number> {
  const c: Record<string, number> = { modified: 0, missing: 0, extra: 0 };
  for (const f of files) if (f.status in c) c[f.status]!++;
  return c;
}

/** Reports by this user in the last hour (the 10/hour limit is durable, not per process). */
export async function recentReportCount(userId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from audit_log
      where actor_user_id = $1 and action = 'skill.signature_mismatch_reported' and created_at > now() - interval '1 hour'`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Record a report: system_event + audit + a `skill.signature_mismatch` notification to every
 * active platform admin (never the maintainers, §73.11). Paths and hashes only — never contents.
 */
export async function recordMismatchReport(
  access: EffectiveAccess,
  skill: FoundSkill,
  semver: string,
  report: { files: MismatchReportFile[]; note: string | null; verdict: string },
): Promise<void> {
  const counts = reportCounts(report.files);
  const nsSlug = skill.namespaceSlug;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await appendAudit(client, {
      actorUserId: access.userId,
      action: "skill.signature_mismatch_reported",
      targetType: "skill_version",
      targetId: `${skill.id}@${semver}`,
      namespaceId: skill.namespaceId,
      after: { skill: `${nsSlug}/${skill.slug}`, semver, verdict: report.verdict, counts, note: report.note, files: report.files.filter((f) => f.status !== "unchanged").slice(0, 200) },
    });
    const bootstrap = process.env.SKILLY_BOOTSTRAP_ADMIN_GROUP?.trim() || null;
    await client.query(
      `with admins as (
         select gm.user_id as id
           from role_mappings rm join group_memberships gm on gm.group_id = rm.group_id
          where rm.role = 'platform_admin'
         union
         select gm.user_id
           from groups g join group_memberships gm on gm.group_id = g.id
          where $2::text is not null and g.entra_object_id = $2
       )
       insert into notifications (user_id, type, payload)
       select u.id, 'skill.signature_mismatch',
              $1::jsonb || jsonb_build_object('reporterName', (select display_name from users where id = $3))
         from admins a join users u on u.id = a.id
        where u.status = 'active' and u.erased_at is null`,
      [
        JSON.stringify({
          namespaceSlug: nsSlug,
          skillSlug: skill.slug,
          semver,
          reporterName: null,
          modified: counts.modified,
          missing: counts.missing,
          extra: counts.extra,
          note: report.note,
        }),
        bootstrap,
        access.userId,
      ],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  void recordSystemEvent({
    status: 200,
    method: "POST",
    route: "/api/skills/[ns]/[slug]/versions/[semver]/statement/report",
    path: `/api/skills/${nsSlug}/${skill.slug}/versions/${semver}/statement/report`,
    userId: access.userId,
    errorCode: "signature_mismatch_reported",
    message: `signature mismatch reported for @${nsSlug}/${skill.slug} v${semver}: ${counts.modified} modified, ${counts.missing} missing, ${counts.extra} extra`,
    requestId: null,
    durationMs: null,
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Administration → Signing (§73.8, §73.9)
// ---------------------------------------------------------------------------

export interface SigningKeyView extends PublicKeyRecord {
  fingerprintDisplay: string;
  status: "active" | "retired" | "revoked";
  revokedBy: { id: string; name: string | null } | null;
  revokedReason: string | null;
  statements: number;
}

export interface SigningAdminView {
  registry: string;
  keys: SigningKeyView[];
  counts: { publish: number; backfill: number; resign: number; variants: number };
  /** Versions that left the publish sweep but have no statement from a non-revoked key. */
  unsigned: number;
  /** Of those, the ones signed only by a revoked key (re-sign pending). */
  resignPending: number;
  reports: { at: string; reporter: string | null; skill: string; semver: string; counts: Record<string, number>; note: string | null }[];
}

export async function signingAdminView(): Promise<SigningAdminView> {
  const { rows: keyRows } = await pool.query<{
    key_id: string; public_key_pem: string; fingerprint: string; created_at: Date; retired_at: Date | null; revoked_at: Date | null;
    revoked_reason: string | null; revoked_by: string | null; revoker_name: string | null; statements: number;
  }>(
    `select k.key_id, k.public_key_pem, k.fingerprint, k.created_at, k.retired_at, k.revoked_at, k.revoked_reason,
            k.revoked_by, u.display_name as revoker_name,
            (select count(*)::int from skill_version_attestations a where a.key_id = k.key_id) as statements
       from signing_keys k left join users u on u.id = k.revoked_by
      order by (k.retired_at is null and k.revoked_at is null) desc, k.created_at desc`,
  );
  const keys: SigningKeyView[] = keyRows.map((k) => ({
    keyId: k.key_id,
    algorithm: "ed25519",
    publicKeyPem: k.public_key_pem,
    fingerprint: k.fingerprint,
    fingerprintDisplay: formatFingerprint(k.fingerprint),
    createdAt: k.created_at.toISOString(),
    retiredAt: k.retired_at?.toISOString() ?? null,
    revokedAt: k.revoked_at?.toISOString() ?? null,
    status: k.revoked_at ? "revoked" : k.retired_at ? "retired" : "active",
    revokedBy: k.revoked_by ? { id: k.revoked_by, name: k.revoker_name } : null,
    revokedReason: k.revoked_reason,
    statements: k.statements,
  }));
  const { rows: countRows } = await pool.query<{ kind: string; variants: boolean; n: number }>(
    `select a.kind, (a.variant_key <> '') as variants, count(*)::int as n
       from skill_version_attestations a join signing_keys k on k.key_id = a.key_id
      where k.revoked_at is null
      group by 1, 2`,
  );
  const counts = { publish: 0, backfill: 0, resign: 0, variants: 0 };
  for (const r of countRows) {
    if (r.variants) counts.variants += r.n;
    else if (r.kind === "publish" || r.kind === "backfill" || r.kind === "resign") counts[r.kind] += r.n;
  }
  const { rows: pend } = await pool.query<{ unsigned: number; resign: number }>(
    `select count(*)::int as unsigned,
            count(*) filter (where exists (select 1 from skill_version_attestations a where a.skill_version_id = sv.id and a.variant_key = ''))::int as resign
       from skill_versions sv
      where sv.artifact_object_key is not null
        and (sv.git_published or sv.status in ('yanked', 'quarantined'))
        and not exists (select 1 from skill_version_attestations a join signing_keys k on k.key_id = a.key_id
                         where a.skill_version_id = sv.id and a.variant_key = '' and k.revoked_at is null)`,
  );
  const { rows: rep } = await pool.query<{ created_at: Date; reporter: string | null; after: { skill?: string; semver?: string; counts?: Record<string, number>; note?: string | null } }>(
    `select al.created_at, u.display_name as reporter, al.after
       from audit_log al left join users u on u.id = al.actor_user_id
      where al.action = 'skill.signature_mismatch_reported'
      order by al.created_at desc limit 50`,
  );
  return {
    registry: signingRegistry(),
    keys,
    counts,
    unsigned: pend[0]?.unsigned ?? 0,
    resignPending: pend[0]?.resign ?? 0,
    reports: rep.map((r) => ({
      at: r.created_at.toISOString(),
      reporter: r.reporter,
      skill: r.after?.skill ?? "",
      semver: r.after?.semver ?? "",
      counts: r.after?.counts ?? {},
      note: r.after?.note ?? null,
    })),
  };
}

export type RevokeResult = { ok: true; affected: number } | { ok: false; status: 404 | 409 | 422; error: string };

/** Revoke a key (§73.9): final, reasoned, audited; the worker's re-sign sweep takes it from here. */
export async function revokeSigningKey(actorUserId: string, keyId: string, reasonRaw: unknown): Promise<RevokeResult> {
  const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
  if (!reason) return { ok: false, status: 422, error: "a reason is required" };
  if (reason.length > 500) return { ok: false, status: 422, error: "the reason must be at most 500 characters" };
  if (!/^[0-9a-f]{16}$/.test(keyId)) return { ok: false, status: 404, error: "unknown key" };
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ revoked_at: Date | null; retired_at: Date | null }>(
      `select revoked_at, retired_at from signing_keys where key_id = $1 for update`,
      [keyId],
    );
    const row = rows[0];
    if (!row) {
      await client.query("rollback");
      return { ok: false, status: 404, error: "unknown key" };
    }
    if (row.revoked_at) {
      await client.query("rollback");
      return { ok: false, status: 409, error: "this key is already revoked" };
    }
    await client.query(`update signing_keys set revoked_at = now(), revoked_by = $2, revoked_reason = $3 where key_id = $1`, [keyId, actorUserId, reason]);
    const { rows: n } = await client.query<{ n: number }>(`select count(*)::int as n from skill_version_attestations where key_id = $1`, [keyId]);
    const affected = n[0]?.n ?? 0;
    await appendAudit(client, {
      actorUserId,
      action: "signing.key_revoked",
      targetType: "signing_key",
      targetId: keyId,
      after: { keyId, reason, statementsAffected: affected, wasActive: !row.retired_at },
    });
    await client.query("commit");
    return { ok: true, affected };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
