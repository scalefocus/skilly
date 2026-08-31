// The install tools' data layer (§29 → §23). An install minted through MCP is an ORDINARY personal
// install token: it appears on /installed, it survives the MCP server being switched off, and
// uninstall is the only way to revoke it. Nothing here is MCP-specific except the caller.
//
// Two things are deliberately impossible from this file:
//   - a SYSTEM installation (`is_system`) — platform-admin only, and administration is outside the
//     MCP surface (§29 Excluded surface). The tool refuses the flag; there is no code path here.
//   - touching anyone else's install — every statement is scoped by `user_id`.
import type { Pool } from "pg";
import {
  buildInstallCommand,
  generateToken,
  hashToken,
  installExpiryCeiling,
} from "@skilly/shared";
import { publicBaseUrl } from "./url.js";
import { getInstallMaxTtlMonths } from "./settings.js";
import { M } from "../metrics.js";

export interface MintResult {
  command: string;
  pinnedSemver: string | null;
  expiresAt: string | null;
}

/**
 * Validate an `expiresAt` against the platform horizon (§23). `undefined` → the default horizon
 * (mirrors what the browser picker preselects); explicit `null` → "Never" (unbounded, an explicit
 * opt-in); a date → capped at `install_max_ttl_months`.
 */
export async function resolveExpiry(
  pool: Pool,
  expiresAt: string | null | undefined,
): Promise<{ value: Date | null } | { error: string }> {
  const months = await getInstallMaxTtlMonths(pool);
  if (expiresAt === null) return { value: null };
  if (expiresAt === undefined) {
    // Default to the horizon rather than "Never": an unbounded credential should be a choice a
    // human made, not what an agent gets by omitting a field.
    const ceiling = installExpiryCeiling(months);
    return { value: new Date(ceiling.getTime() - 2 * 86_400_000) };
  }
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return { error: `expiresAt is not a valid date/time: ${expiresAt}` };
  if (d.getTime() <= Date.now()) return { error: "expiresAt must be in the future" };
  const ceiling = installExpiryCeiling(months);
  if (d.getTime() > ceiling.getTime()) {
    return { error: `expiresAt is beyond this registry's install-expiry horizon of ${months} month(s)` };
  }
  return { value: d };
}

/**
 * Mint a personal install token and build the `npx skills add` command. Mirrors the web tier's
 * mintInstallToken, including the supersede-unclaimed purge: re-generating (changed version or
 * expiry, or just calling again) invalidates any earlier command that was never claimed, so unused
 * valid tokens don't pile up. Claimed installs survive. The purge never crosses the system
 * boundary — it only ever touches this user's own non-system tokens.
 */
export async function mintInstall(
  pool: Pool,
  userId: string,
  skill: { id: string; namespaceSlug: string; skillSlug: string; toolHarness: string },
  pinnedSemver: string | null,
  expiresAt: Date | null,
): Promise<MintResult> {
  const raw = generateToken();
  await pool.query(
    `delete from tokens where user_id = $1 and skill_id = $2 and type = 'install' and not is_system and used_at is null`,
    [userId, skill.id],
  );
  await pool.query(
    `insert into tokens (user_id, type, hashed_token, skill_id, pinned_semver, scope, expires_at, is_system, created_by_user_id)
     values ($1, 'install', $2, $3, $4, $5::jsonb, $6, false, null)`,
    [userId, hashToken(raw), skill.id, pinnedSemver, JSON.stringify({ skillId: skill.id, semver: pinnedSemver }), expiresAt],
  );
  M.mcpInstallsMinted.inc();
  return {
    command: buildInstallCommand({
      registryBaseUrl: publicBaseUrl(),
      namespaceSlug: skill.namespaceSlug,
      skillSlug: skill.skillSlug,
      semver: pinnedSemver,
      token: raw,
      agent: skill.toolHarness,
    }),
    pinnedSemver,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
}

export interface InstallView {
  id: string;
  namespaceSlug: string;
  skillSlug: string;
  title: string;
  pinnedSemver: string | null;
  installedAt: string;
  expiresAt: string | null;
  inactive: boolean;
  skillArchived: boolean;
}

/** The caller's own USED installs (§23). System installs have no MCP equivalent. */
export async function listInstalls(pool: Pool, userId: string): Promise<InstallView[]> {
  const { rows } = await pool.query<{
    id: string;
    pinned_semver: string | null;
    used_at: string;
    expires_at: string | null;
    ns_slug: string;
    skill_slug: string;
    title: string;
    inactive: boolean;
    skill_status: "active" | "archived";
  }>(
    `select t.id, t.pinned_semver, t.used_at, t.expires_at,
            n.slug as ns_slug, s.slug as skill_slug, s.title, s.status as skill_status,
            (t.expires_at is not null and t.expires_at <= now()) as inactive
       from tokens t
       join skills s on s.id = t.skill_id
       join namespaces n on n.id = s.namespace_id
      where t.user_id = $1 and t.type = 'install' and t.used_at is not null
      order by lower(s.title) asc, t.used_at desc`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    namespaceSlug: r.ns_slug,
    skillSlug: r.skill_slug,
    title: r.title,
    pinnedSemver: r.pinned_semver,
    installedAt: r.used_at,
    expiresAt: r.expires_at,
    inactive: r.inactive,
    skillArchived: r.skill_status === "archived",
  }));
}

/** Uninstall = hard-delete the token. Owner-scoped, so a system install can never be hit. */
export async function uninstall(pool: Pool, userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `delete from tokens where id = $1 and user_id = $2 and type = 'install' and not is_system`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

/** Reactivate an INACTIVE install by setting a new expiry on the SAME token (§23). */
export async function reactivate(pool: Pool, userId: string, id: string, expiresAt: Date | null): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update tokens set expires_at = $3
      where id = $1 and user_id = $2 and type = 'install' and not is_system
        and used_at is not null and expires_at is not null and expires_at <= now()`,
    [id, userId, expiresAt],
  );
  return (rowCount ?? 0) > 0;
}
