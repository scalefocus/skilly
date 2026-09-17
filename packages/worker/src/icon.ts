// Worker-side icon normalization + storage — mirrors packages/web/src/lib/icons.ts exactly
// (both write the same skill_icons table) so a bundle-borne icon found while mirroring a
// Pointer skill is stored identically to one uploaded through the web UI. SKILLY_SPEC.md §33.
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Pool } from "pg";
import { detectImageFormat, ICON_MAX_SOURCE_BYTES, ICON_MIN_DIMENSION, ICON_MAX_DIMENSION, ICON_OUTPUT_SIZE } from "@skilly/shared/icon";

/** Validate + normalize + store a candidate icon image; returns null (never throws) on any
 *  format/size/dimension problem — bundle icon extraction is advisory, never blocking (§33.3). */
export async function ingestBundleIcon(pool: Pool, rawBytes: Buffer): Promise<string | null> {
  if (rawBytes.byteLength > ICON_MAX_SOURCE_BYTES) return null;
  if (!detectImageFormat(rawBytes)) return null;
  try {
    const meta = await sharp(rawBytes, { limitInputPixels: ICON_MAX_DIMENSION * ICON_MAX_DIMENSION }).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (Math.min(w, h) < ICON_MIN_DIMENSION || Math.max(w, h) > ICON_MAX_DIMENSION) return null;
    const normalized = await sharp(rawBytes, { limitInputPixels: ICON_MAX_DIMENSION * ICON_MAX_DIMENSION })
      .rotate()
      .resize(ICON_OUTPUT_SIZE, ICON_OUTPUT_SIZE, { fit: "cover", position: "centre" })
      .png()
      .toBuffer();
    const sha256 = createHash("sha256").update(normalized).digest("hex");
    await pool.query(
      `insert into skill_icons (sha256, bytes, created_by) values ($1, $2, null) on conflict (sha256) do nothing`,
      [sha256, normalized],
    );
    return sha256;
  } catch {
    return null;
  }
}
