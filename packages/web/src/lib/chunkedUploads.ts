// Chunked hosted-bundle upload staging (§6): session bookkeeping in `upload_sessions`, part
// bytes in object storage under the dedicated STAGING_PREFIX. Nothing here is ever servable —
// no catalog table references a staging key, and the real artifact key is only written by the
// shared ingest pipeline at complete time (invariant #4 untouched).
//
// Store + pool are injectable so the dbtest can run against an in-memory store.
import type { Pool } from "pg";
import { pool } from "./db";
import { s3ArtifactStore, type ArtifactStore } from "./objectStore";
import { partCount, partSize } from "./chunkMath";
import { fmtSize } from "./uploadPipeline";

export const STAGING_PREFIX = "uploads/staging/";
/** A staging session (row + parts) older than this is an orphan — swept on every new start. §6. */
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/** Ceiling on concurrently open sessions per user (409 above it). §6. */
export const MAX_OPEN_SESSIONS_PER_USER = 3;

export interface UploadSession {
  id: string;
  userId: string;
  skillSlug: string;
  filename: string;
  totalBytes: number;
  chunkBytes: number;
  createdAt: Date;
}

export function stagingKey(uploadId: string, index: number): string {
  return `${STAGING_PREFIX}${uploadId}/${index}`;
}

interface SessionRow {
  id: string;
  user_id: string;
  skill_slug: string;
  filename: string;
  total_bytes: string; // bigint comes back as text
  chunk_bytes: number;
  created_at: Date;
}

function toSession(r: SessionRow): UploadSession {
  return { id: r.id, userId: r.user_id, skillSlug: r.skill_slug, filename: r.filename, totalBytes: Number(r.total_bytes), chunkBytes: r.chunk_bytes, createdAt: r.created_at };
}

/**
 * Sweep orphaned staging state (§6): delete every session ROW older than the TTL, and every
 * staging OBJECT last modified before the TTL. The two sides are swept independently (no
 * cross-referencing), so an object whose row vanished — or a row whose objects were already
 * gone — still converges within one sweep. Best-effort: a sweep failure never blocks the
 * upload that triggered it.
 */
export async function sweepStaleSessions(db: Pool = pool, store: ArtifactStore = s3ArtifactStore(), now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - SESSION_TTL_MS);
  await db.query(`delete from upload_sessions where created_at < $1`, [cutoff]);
  const objects = await store.list(STAGING_PREFIX);
  for (const o of objects) {
    if (o.lastModified && o.lastModified < cutoff) await store.delete(o.key);
  }
}

export type CreateSessionResult = { session: UploadSession } | { error: string; status: 409 | 413 | 422 };

/** Open a new chunked-upload session. Caller has already swept + resolved the settings. */
export async function createSession(
  userId: string,
  input: { skillSlug: string; filename: string; totalBytes: number },
  limits: { maxBundleBytes: number; chunkBytes: number },
  db: Pool = pool,
): Promise<CreateSessionResult> {
  if (!input.skillSlug || !input.filename) return { error: "skillSlug and filename are required", status: 422 };
  if (!Number.isInteger(input.totalBytes) || input.totalBytes <= 0) return { error: "totalBytes must be a positive integer", status: 422 };
  if (input.totalBytes > limits.maxBundleBytes) {
    return { error: `the bundle is bigger than the allowed size of ${fmtSize(limits.maxBundleBytes)}`, status: 413 };
  }
  const open = await db.query<{ n: string }>(`select count(*)::text as n from upload_sessions where user_id = $1`, [userId]);
  if (Number(open.rows[0]!.n) >= MAX_OPEN_SESSIONS_PER_USER) {
    return { error: `too many uploads in progress — finish or cancel one first (limit ${MAX_OPEN_SESSIONS_PER_USER})`, status: 409 };
  }
  const { rows } = await db.query<SessionRow>(
    `insert into upload_sessions (user_id, skill_slug, filename, total_bytes, chunk_bytes)
     values ($1, $2, $3, $4, $5)
     returning id, user_id, skill_slug, filename, total_bytes, chunk_bytes, created_at`,
    [userId, input.skillSlug.slice(0, 200), input.filename.slice(0, 300), input.totalBytes, limits.chunkBytes],
  );
  return { session: toSession(rows[0]!) };
}

/** The caller's own session, or null (missing or not theirs — indistinguishable on purpose). */
export async function getOwnSession(id: string, userId: string, db: Pool = pool): Promise<UploadSession | null> {
  const { rows } = await db.query<SessionRow>(
    `select id, user_id, skill_slug, filename, total_bytes, chunk_bytes, created_at
       from upload_sessions where id = $1 and user_id = $2`,
    [id, userId],
  );
  return rows[0] ? toSession(rows[0]) : null;
}

export type PutPartResult = { ok: true } | { error: string; status: 422 };

/** Stage one part. Exact-size enforcement (§6); a re-PUT of the same index overwrites. */
export async function putPart(session: UploadSession, index: number, body: Buffer, store: ArtifactStore = s3ArtifactStore()): Promise<PutPartResult> {
  const count = partCount(session.totalBytes, session.chunkBytes);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    return { error: `part index must be between 0 and ${count - 1}`, status: 422 };
  }
  const expected = partSize(session.totalBytes, session.chunkBytes, index);
  if (body.length !== expected) {
    return { error: `part ${index} must be exactly ${expected} bytes (got ${body.length})`, status: 422 };
  }
  await store.put(stagingKey(session.id, index), body, "application/octet-stream");
  return { ok: true };
}

export type AssembleResult = { bytes: Buffer } | { error: string; status: 409 };

/** Read every part in index order and reassemble the bundle; 409 when any part is missing or
 *  the wrong size (client retries the part or restarts the session). */
export async function assembleParts(session: UploadSession, store: ArtifactStore = s3ArtifactStore()): Promise<AssembleResult> {
  const count = partCount(session.totalBytes, session.chunkBytes);
  const parts: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    let part: Buffer;
    try {
      part = await store.get(stagingKey(session.id, i));
    } catch {
      return { error: `part ${i} of ${count} has not been uploaded`, status: 409 };
    }
    const expected = partSize(session.totalBytes, session.chunkBytes, i);
    if (part.length !== expected) return { error: `part ${i} is ${part.length} bytes, expected ${expected}`, status: 409 };
    parts.push(part);
  }
  return { bytes: Buffer.concat(parts) };
}

/** Delete the session row + every staged part. Idempotent; used by complete (any outcome) and
 *  abort. Object deletion is best-effort — the 2 h sweep collects any straggler. */
export async function destroySession(session: UploadSession, db: Pool = pool, store: ArtifactStore = s3ArtifactStore()): Promise<void> {
  await db.query(`delete from upload_sessions where id = $1`, [session.id]);
  const count = partCount(session.totalBytes, session.chunkBytes);
  for (let i = 0; i < count; i++) {
    try {
      await store.delete(stagingKey(session.id, i));
    } catch {
      // swept later
    }
  }
}
