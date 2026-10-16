// Artifact integrity check before synthesis (SKILLY_SPEC.md §49.12).
//
// `skill_versions` is immutable at the row level (the DB guard), but the bytes the row points at
// live in the object store, where anyone holding the store credentials could overwrite them. Every
// path that turns stored bytes into a served git tag — the publish sweep, the reprovision/self-heal
// sweep and the pointer refresh's stored-side comparison — therefore re-hashes what it read and
// refuses to proceed on a mismatch. Nothing is overwritten or deleted automatically: the version
// stays unpublished, a system_event + audit row record it, and a human decides.
import { createHash } from "node:crypto";
import type { Pool } from "pg";

export interface IntegritySubject {
  versionId: string;
  skillId: string;
  semver: string;
  artifactKey: string;
  /** The hash recorded when the version was created; null for legacy rows (then no check). */
  expectedSha256: string | null;
  namespaceId?: string | null;
  nsSlug?: string;
  skillSlug?: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** In-process memo so one tampered object is recorded once per worker life, not every sweep. */
const recorded = new Set<string>();

/**
 * True when the bytes match the version's recorded `artifact_sha256` (or no hash was recorded).
 * False — after recording the event — when they do not; the caller must skip the version.
 */
export async function verifyArtifactIntegrity(pool: Pool, v: IntegritySubject, bytes: Uint8Array, route = "worker:publish"): Promise<boolean> {
  if (!v.expectedSha256) return true;
  const actual = sha256Hex(bytes);
  if (actual === v.expectedSha256.toLowerCase()) return true;
  const key = `${v.versionId}:${actual}`;
  console.error(JSON.stringify({ level: "error", msg: "artifact integrity mismatch — version left unpublished", versionId: v.versionId, key: v.artifactKey, expected: v.expectedSha256, actual }));
  if (recorded.has(key)) return false;
  recorded.add(key);
  const label = v.nsSlug && v.skillSlug ? `@${v.nsSlug}/${v.skillSlug}` : v.skillId;
  try {
    await pool.query(
      `insert into system_event (status, method, route, path, user_id, actor_name, actor_email, error_code, message, source)
       values (500, 'JOB', $1, $2, null, null, null, 'artifact_integrity_mismatch', $3, 'worker')`,
      [route.slice(0, 300), `/${v.artifactKey}`.slice(0, 500), `stored artifact for ${label} v${v.semver} does not match its recorded hash — not published`.slice(0, 300)],
    );
    await pool.query(
      `insert into audit_log (actor_user_id, action, target_type, target_id, namespace_id, after, source)
       values (null, 'skill.artifact_integrity_failed', 'skill_version', $1, $2, $3::jsonb, 'worker')`,
      [`${v.skillId}@${v.semver}`, v.namespaceId ?? null, JSON.stringify({ skill: v.skillSlug ?? null, semver: v.semver, artifactKey: v.artifactKey, expected: v.expectedSha256, actual })],
    );
  } catch (err) {
    console.error(JSON.stringify({ level: "warn", msg: "could not record integrity mismatch", err: String(err) }));
  }
  return false;
}
