// Install tokens = the durable consumer "installation" handle (SKILLY_SPEC.md §23). Each is a
// reusable, skill-scoped token with an optional pinned version and an optional expiry (null =
// never). The raw token is shown once (baked into the install URL); only its hash is stored.
import { pool } from "./db";
import { generateToken, hashToken } from "@skilly/shared";
import { M } from "./metrics";

/**
 * Mint a new (unused) install token. `expiresAt` null = never; `pinnedSemver` null = latest.
 * A SYSTEM installation (§23) is platform-owned: `user_id` is null, `is_system` is set, and the
 * minting platform admin is recorded in `created_by_user_id` (provenance only, no authority).
 */
export async function mintInstallToken(
  userId: string,
  skillId: string,
  pinnedSemver: string | null,
  expiresAt: Date | null,
  opts: { system?: boolean } = {},
): Promise<{ raw: string }> {
  const raw = generateToken();
  const system = opts.system === true;
  // Supersede the prior UNCLAIMED install tokens for this skill: regenerating a command (changed
  // version/expiry, or just re-clicking Install) invalidates any earlier one that was never
  // claimed by `npx skills` (used_at still null), so we delete those here to avoid piling up
  // dangling valid tokens. Purge scopes never cross the system boundary (§23): a personal mint
  // purges the minting user's unclaimed personal tokens; a SYSTEM mint purges unclaimed system
  // tokens for that skill across ALL admins (the last generated system command is the live one).
  // CLAIMED installs (used_at set) are the durable handle — left intact; the worker also purges
  // siblings on first claim (markInstallUsed). SKILLY_SPEC.md §23.
  if (system) {
    await pool.query(
      `delete from tokens where skill_id = $1 and type = 'install' and is_system and used_at is null`,
      [skillId],
    );
  } else {
    await pool.query(
      `delete from tokens where user_id = $1 and skill_id = $2 and type = 'install' and not is_system and used_at is null`,
      [userId, skillId],
    );
  }
  await pool.query(
    `insert into tokens (user_id, type, hashed_token, skill_id, pinned_semver, scope, expires_at, is_system, created_by_user_id)
     values ($1, 'install', $2, $3, $4, $5::jsonb, $6, $7, $8)`,
    // scope.skillId is also populated so the gateway's existing skill-scope check keeps working.
    [
      system ? null : userId,
      hashToken(raw),
      skillId,
      pinnedSemver,
      JSON.stringify({ skillId, semver: pinnedSemver }),
      expiresAt,
      system,
      system ? userId : null,
    ],
  );
  M.tokensMinted.inc({ type: "install" });
  M.installCommands.inc();
  return { raw };
}

export interface InstallView {
  id: string;
  namespaceSlug: string;
  skillSlug: string;
  title: string;
  pinnedSemver: string | null; // null = latest
  installedAt: string; // used_at
  expiresAt: string | null; // null = never
  inactive: boolean; // used but past expiry
  clientUserAgent: string | null;
  clientIp: string | null; // originating IP of the first clone; null if unknown
  skillArchived: boolean;
}

/** A user's USED installs (generated-but-unused tokens are ephemeral and not listed). §23 */
export async function listInstalls(userId: string): Promise<InstallView[]> {
  const { rows } = await pool.query<{
    id: string; pinned_semver: string | null; used_at: string; expires_at: string | null;
    client_user_agent: string | null; client_ip: string | null; ns_slug: string; skill_slug: string;
    title: string; inactive: boolean; skill_status: "active" | "archived";
  }>(
    `select t.id, t.pinned_semver, t.used_at, t.expires_at, t.client_user_agent, t.client_ip,
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
    clientUserAgent: r.client_user_agent,
    clientIp: r.client_ip,
    skillArchived: r.skill_status === "archived",
  }));
}

export interface SystemInstallView extends InstallView {
  /** Display label of the platform admin who minted it (tombstone label if since erased). */
  mintedBy: string | null;
}

/** All USED system installations, platform-wide (§23; the caller must be a platform admin). */
export async function listSystemInstalls(): Promise<SystemInstallView[]> {
  const { rows } = await pool.query<{
    id: string; pinned_semver: string | null; used_at: string; expires_at: string | null;
    client_user_agent: string | null; client_ip: string | null; ns_slug: string; skill_slug: string;
    title: string; inactive: boolean; skill_status: "active" | "archived"; minted_by: string | null;
  }>(
    `select t.id, t.pinned_semver, t.used_at, t.expires_at, t.client_user_agent, t.client_ip,
            n.slug as ns_slug, s.slug as skill_slug, s.title, s.status as skill_status,
            (t.expires_at is not null and t.expires_at <= now()) as inactive,
            u.display_name as minted_by
       from tokens t
       join skills s on s.id = t.skill_id
       join namespaces n on n.id = s.namespace_id
       left join users u on u.id = t.created_by_user_id
      where t.type = 'install' and t.is_system and t.used_at is not null
      order by lower(s.title) asc, t.used_at desc`,
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
    clientUserAgent: r.client_user_agent,
    clientIp: r.client_ip,
    skillArchived: r.skill_status === "archived",
    mintedBy: r.minted_by,
  }));
}

/**
 * Look up one install token's authz-relevant shape (§23): whether it's a system installation
 * (platform-admin-managed) or a personal one (owner-managed), plus audit context. Null = no row.
 */
export async function getInstallMeta(id: string): Promise<{
  isSystem: boolean; userId: string | null; skillId: string;
  namespaceId: string; skillRef: string; pinnedSemver: string | null; expiresAt: string | null;
} | null> {
  const { rows } = await pool.query<{
    is_system: boolean; user_id: string | null; skill_id: string; namespace_id: string;
    ns_slug: string; skill_slug: string; pinned_semver: string | null; expires_at: string | null;
  }>(
    `select t.is_system, t.user_id, t.skill_id, s.namespace_id, n.slug as ns_slug,
            s.slug as skill_slug, t.pinned_semver, t.expires_at
       from tokens t
       join skills s on s.id = t.skill_id
       join namespaces n on n.id = s.namespace_id
      where t.id = $1 and t.type = 'install'`,
    [id],
  );
  const r = rows[0];
  return r
    ? {
        isSystem: r.is_system,
        userId: r.user_id,
        skillId: r.skill_id,
        namespaceId: r.namespace_id,
        skillRef: `${r.ns_slug}/${r.skill_slug}`,
        pinnedSemver: r.pinned_semver,
        expiresAt: r.expires_at,
      }
    : null;
}

/**
 * Record a detail-page download as a (deduped) install bump. The DB function inserts a
 * `skill_downloads` ledger row and, ONLY on the user's FIRST download of this skill, increments
 * `skills.install_count` + the monthly `install_counters` + an `access_log` row. A download is
 * never an install TOKEN, so it never appears on the Installed Skills page (§10/§23). Returns true
 * when this download was counted (the user's first), false on a repeat.
 */
export async function recordFirstDownload(skillId: string, userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ record_skill_download: boolean }>(
    `select record_skill_download($1, $2)`,
    [skillId, userId],
  );
  return rows[0]?.record_skill_download ?? false;
}

/** Uninstall = hard-delete the token (owner-scoped). The URL is then refused at the gateway. */
export async function uninstall(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `delete from tokens where id = $1 and user_id = $2 and type = 'install'`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

/** Uninstall a SYSTEM installation (§23) — any platform admin; the route enforces the role. */
export async function uninstallSystem(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `delete from tokens where id = $1 and type = 'install' and is_system`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Reactivate an INACTIVE install by setting a new expiry (date or null=never) on the SAME token,
 * so the user's existing URL works again. Owner-scoped; only matches rows that are currently
 * used + expired, so active installs and other users' rows are untouched.
 */
export async function reactivate(userId: string, id: string, expiresAt: Date | null): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update tokens set expires_at = $3
      where id = $1 and user_id = $2 and type = 'install'
        and used_at is not null and expires_at is not null and expires_at <= now()`,
    [id, userId, expiresAt],
  );
  return (rowCount ?? 0) > 0;
}

/** Reactivate an inactive SYSTEM installation (§23) — any platform admin; role checked by the route. */
export async function reactivateSystem(id: string, expiresAt: Date | null): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update tokens set expires_at = $2
      where id = $1 and type = 'install' and is_system
        and used_at is not null and expires_at is not null and expires_at <= now()`,
    [id, expiresAt],
  );
  return (rowCount ?? 0) > 0;
}
