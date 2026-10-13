// Worker-side reader for the platform settings the scan/mirror pipeline needs. The web tier owns
// writing (and validating) these; the worker only reads. Kept tiny + defensive — a missing/garbled
// row falls back to the same 200 MB default as the web tier (lib/settings.ts), never throws.
import type { Pool } from "pg";
import { coerceDigestSettings, DEFAULT_DIGEST_SETTINGS, DIGEST_SETTING_KEYS, type DigestSettings } from "@skilly/shared";

const DEFAULT_MAX_BUNDLE_BYTES = 200 * 1024 * 1024;

/** The §48 email-digest settings, read fresh by the delivery and digest sweeps. A missing or
 *  garbled key — or a failed read — falls back to the shared defaults, never throws. */
export async function getDigestSettings(pool: Pool): Promise<DigestSettings> {
  try {
    const { rows } = await pool.query<{ key: string; value: unknown }>(
      `select key, value from platform_settings where key = any($1::text[])`,
      [Object.values(DIGEST_SETTING_KEYS)],
    );
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return coerceDigestSettings((k) => map.get(k));
  } catch {
    return { ...DEFAULT_DIGEST_SETTINGS, types: [...DEFAULT_DIGEST_SETTINGS.types] };
  }
}

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
