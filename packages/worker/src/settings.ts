// Worker-side reader for the platform settings the scan/mirror pipeline needs. The web tier owns
// writing (and validating) these; the worker only reads. Kept tiny + defensive — a missing/garbled
// row falls back to the same 200 MB default as the web tier (lib/settings.ts), never throws.
import type { Pool } from "pg";

const DEFAULT_MAX_BUNDLE_BYTES = 200 * 1024 * 1024;

/** The admin-configured maximum hosted-bundle size (bytes). Falls back to 200 MB. */
export async function getMaxBundleBytes(pool: Pool): Promise<number> {
  try {
    const { rows } = await pool.query<{ value: string }>(
      `select value::text as value from platform_settings where key = 'max_bundle_bytes'`,
    );
    const n = Number(rows[0]?.value);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BUNDLE_BYTES;
  } catch {
    return DEFAULT_MAX_BUNDLE_BYTES;
  }
}
