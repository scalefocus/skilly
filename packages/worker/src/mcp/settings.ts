// Worker-side reader for the §29 MCP platform settings. The web tier owns writing + validating
// them (Administration → MCP server); the worker only reads. Kept tiny and defensive: a missing or
// garbled row falls back to the shared default via the shared coercers, never throws — and the
// on/off flag ships ON, so a registry that has never touched the setting has MCP enabled.
import type { Pool } from "pg";
import {
  coerceMcpEnabled,
  coerceMcpAccessTtlMinutes,
  coerceMcpRefreshTtlDays,
  coerceMcpInlineUploadBytes,
  coerceMcpResourceBytes,
} from "@skilly/shared";

export interface McpSettings {
  enabled: boolean;
  accessTtlMinutes: number;
  refreshTtlDays: number;
  inlineUploadBytes: number;
  resourceBytes: number;
}

const KEYS = [
  "mcp_enabled",
  "mcp_access_token_ttl_minutes",
  "mcp_refresh_token_ttl_days",
  "mcp_max_inline_upload_bytes",
  "mcp_max_resource_bytes",
] as const;

// Every MCP request reads these, so cache briefly. A flipped toggle takes effect within seconds —
// fast enough for a kill-switch, cheap enough to not re-query per JSON-RPC call.
const TTL_MS = Number(process.env.MCP_SETTINGS_CACHE_TTL_MS ?? 5_000);
let cache: { at: number; value: McpSettings } | null = null;

export function invalidateMcpSettingsCache(): void {
  cache = null;
}

export async function getMcpSettings(pool: Pool): Promise<McpSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let map = new Map<string, unknown>();
  try {
    const { rows } = await pool.query<{ key: string; value: unknown }>(
      `select key, value from platform_settings where key = any($1::text[])`,
      [[...KEYS]],
    );
    map = new Map(rows.map((r) => [r.key, r.value]));
  } catch {
    // DB hiccup: fall through to defaults rather than failing the request in a way that would
    // look like "MCP is broken". A real outage will surface on the first query the tool makes.
  }
  const value: McpSettings = {
    enabled: coerceMcpEnabled(map.get("mcp_enabled")),
    accessTtlMinutes: coerceMcpAccessTtlMinutes(map.get("mcp_access_token_ttl_minutes")),
    refreshTtlDays: coerceMcpRefreshTtlDays(map.get("mcp_refresh_token_ttl_days")),
    inlineUploadBytes: coerceMcpInlineUploadBytes(map.get("mcp_max_inline_upload_bytes")),
    resourceBytes: coerceMcpResourceBytes(map.get("mcp_max_resource_bytes")),
  };
  cache = { at: Date.now(), value };
  return value;
}

/** The admin-configured maximum hosted-bundle size (bytes) — shared with the web upload path. */
export async function getMaxBundleBytesSetting(pool: Pool): Promise<number> {
  try {
    const { rows } = await pool.query<{ value: string }>(
      `select value::text as value from platform_settings where key = 'max_bundle_bytes'`,
    );
    const n = Number(rows[0]?.value);
    return Number.isFinite(n) && n > 0 ? n : 200 * 1024 * 1024;
  } catch {
    return 200 * 1024 * 1024;
  }
}

/** Whether open contribution is on (§4 `proposals_open`) — gates the propose tools for non-members. */
export async function getProposalsOpen(pool: Pool): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ value: unknown }>(
      `select value from platform_settings where key = 'proposals_open'`,
    );
    const v = rows[0]?.value;
    return typeof v === "boolean" ? v : true;
  } catch {
    return true;
  }
}

/** The install-expiry horizon in calendar months (§23) — bounds `install_skill`'s expiresAt. */
export async function getInstallMaxTtlMonths(pool: Pool): Promise<number> {
  try {
    const { rows } = await pool.query<{ value: unknown }>(
      `select value from platform_settings where key = 'install_max_ttl_months'`,
    );
    const v = rows[0]?.value;
    return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 120 ? (v as number) : 12;
  } catch {
    return 12;
  }
}
