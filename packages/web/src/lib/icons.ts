// Skill icon normalization + content-addressed storage (§33). Every icon — uploaded or
// bundle-borne — is decoded under a pixel-count guard and RE-ENCODED to a fixed-size PNG with
// metadata stripped: this is the sanitizer (defuses polyglot files / EXIF payloads), which is why
// icons deliberately skip ClamAV (§22, §33.3). Never serves an icon as uploaded.
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Pool, PoolClient } from "pg";
import { pool } from "./db";
import {
  detectImageFormat,
  ICON_MAX_SOURCE_BYTES,
  ICON_MIN_DIMENSION,
  ICON_MAX_DIMENSION,
  ICON_OUTPUT_SIZE,
} from "@skilly/shared/icon";

export interface IconValidationError {
  status: 413 | 422;
  error: string;
}

/**
 * Validate a candidate icon image (format/size/dimensions) without normalizing it yet — used by
 * both the upload endpoint (client-visible errors) and bundle ingest (soft warnings, §33.3).
 */
export async function validateIconSource(bytes: Buffer): Promise<IconValidationError | null> {
  if (bytes.byteLength > ICON_MAX_SOURCE_BYTES) {
    return { status: 413, error: "the icon is bigger than the allowed size of 512 KB" };
  }
  const format = detectImageFormat(bytes);
  if (!format) {
    return { status: 422, error: "unsupported icon format — use PNG, JPEG, or WebP (SVG and GIF are not accepted)" };
  }
  try {
    // limitInputPixels bounds decompression-bomb exposure BEFORE the full decode.
    const meta = await sharp(bytes, { limitInputPixels: ICON_MAX_DIMENSION * ICON_MAX_DIMENSION }).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (Math.min(w, h) < ICON_MIN_DIMENSION) {
      return { status: 422, error: `the icon is too small (min ${ICON_MIN_DIMENSION}×${ICON_MIN_DIMENSION}px)` };
    }
    if (Math.max(w, h) > ICON_MAX_DIMENSION) {
      return { status: 422, error: `the icon is too large (max ${ICON_MAX_DIMENSION}px on the longer side)` };
    }
  } catch {
    return { status: 422, error: "could not read the icon image — it may be corrupt" };
  }
  return null;
}

/**
 * Normalize a validated icon: centre-crop to square, resize to 256×256, re-encode as PNG,
 * metadata stripped. The output bytes are what gets hashed and stored — the input is discarded.
 */
export async function normalizeIcon(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, { limitInputPixels: ICON_MAX_DIMENSION * ICON_MAX_DIMENSION })
    .rotate() // honor EXIF orientation before it's stripped
    .resize(ICON_OUTPUT_SIZE, ICON_OUTPUT_SIZE, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
}

/** Store a normalized icon content-addressed by the sha256 of its bytes; dedupes automatically.
 *  Accepts a `Pool | PoolClient` (defaults to the module pool) so a caller inside a transaction
 *  (e.g. a live-DB test) can pass its own client and have the insert roll back with it. */
export async function storeIcon(normalized: Buffer, createdBy: string | null, db: Pool | PoolClient = pool): Promise<string> {
  const sha256 = createHash("sha256").update(normalized).digest("hex");
  await db.query(
    `insert into skill_icons (sha256, bytes, created_by) values ($1, $2, $3) on conflict (sha256) do nothing`,
    [sha256, normalized, createdBy],
  );
  return sha256;
}

/** Validate + normalize + store an icon in one step (used by both /api/icons and bundle ingest). */
export async function ingestIcon(
  rawBytes: Buffer,
  createdBy: string | null,
  db: Pool | PoolClient = pool,
): Promise<{ ok: true; sha256: string } | { ok: false; error: IconValidationError }> {
  const err = await validateIconSource(rawBytes);
  if (err) return { ok: false, error: err };
  const normalized = await normalizeIcon(rawBytes);
  const sha256 = await storeIcon(normalized, createdBy, db);
  return { ok: true, sha256 };
}

export async function getIconBytes(sha256: string, db: Pool | PoolClient = pool): Promise<Buffer | null> {
  const { rows } = await db.query<{ bytes: Buffer }>(`select bytes from skill_icons where sha256 = $1`, [sha256]);
  return rows[0]?.bytes ?? null;
}

/** True when `sha256` was uploaded by `userId` — the ownership check for the icon on a
 *  submission payload (mirrors the hosted-bundle artifact-ownership check, §33.3). */
export async function iconOwnedBy(sha256: string, userId: string, db: Pool | PoolClient = pool): Promise<boolean> {
  const { rowCount } = await db.query(`select 1 from skill_icons where sha256 = $1 and created_by = $2`, [sha256, userId]);
  return !!rowCount;
}

/** The URL an icon is served at — content-addressed, unauthenticated, immutable. */
export function iconUrl(sha256: string): string {
  return `/skill-icons/${sha256}.png`;
}
