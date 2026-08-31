// Bearer-token authentication + RBAC resolution for the §29 MCP server.
//
// Two invariants live here:
//   #1 — roles are re-resolved from SCIM-synced group membership on EVERY call. The access token
//        carries only a grant id; it never carries roles, namespaces or claims. A user who loses a
//        role loses it on their next MCP call, not at token expiry.
//   Leaver handling — a non-`active` user resolves to no user at all (the shared
//        SQL_USER_GROUPS_BY_ID filters on status), and their grants are revoked outright by the
//        erase/deactivate path. Either way the token stops working.
import type { Pool } from "pg";
import {
  hashToken,
  accessFromRows,
  SQL_USER_GROUPS_BY_ID,
  SQL_ROLE_MAPPINGS,
  type EffectiveAccess,
  type RoleMappingRow,
  type UserGroupRow,
} from "@skilly/shared";

/** Everything a tool handler needs about who is calling. */
export interface McpCaller {
  userId: string;
  access: EffectiveAccess;
  grantId: string;
  /** The registered client's display name — the "via MCP · <client>" attribution marker (§29). */
  clientName: string;
  clientDbId: string;
}

export type AuthFailure =
  | "missing_token"
  | "mcp_token_invalid"
  | "mcp_token_expired"
  | "mcp_grant_revoked"
  | "mcp_client_blocked"
  | "mcp_owner_inactive";

export type AuthResult = { ok: true; caller: McpCaller } | { ok: false; reason: AuthFailure };

/**
 * Extract a bearer token from the Authorization header. Header only — never a query string.
 *
 * Parsed by hand rather than with `/^Bearer\s+(.+)$/i`: that pattern is polynomial-time on
 * attacker-controlled input (CodeQL js/polynomial-redos — `\s+` followed by `.+` backtracks on a
 * header carrying many spaces), and this is the most attacker-controlled string the server reads.
 * The scan below is linear and accepts exactly what RFC 6750 allows: the `Bearer` keyword,
 * case-insensitive, one or more spaces/tabs, then the credential.
 */
export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const h = header.trim();
  if (h.length <= 6) return null;
  if (h.slice(0, 6).toLowerCase() !== "bearer") return null;
  // The keyword must be followed by whitespace — "bearertoken" is not a bearer credential.
  const isSpace = (c: number) => c === 32 || c === 9;
  if (!isSpace(h.charCodeAt(6))) return null;
  let i = 6;
  while (i < h.length && isSpace(h.charCodeAt(i))) i++;
  const raw = h.slice(i).trim();
  return raw ? raw : null;
}

// Role mappings are org-wide and change only on a SCIM reconcile / admin edit; the per-user resolve
// is cached very briefly so one agent's burst of tool calls doesn't re-read the mapping table each
// time. Same posture (and same reasoning) as the web tier's access cache.
const ROLE_TTL_MS = Number(process.env.RBAC_ROLE_CACHE_TTL_MS ?? 30_000);
let roleCache: { at: number; rows: RoleMappingRow[] } | null = null;

async function loadRoleMappings(pool: Pool): Promise<RoleMappingRow[]> {
  if (roleCache && Date.now() - roleCache.at < ROLE_TTL_MS) return roleCache.rows;
  const { rows } = await pool.query<RoleMappingRow>(SQL_ROLE_MAPPINGS);
  roleCache = { at: Date.now(), rows };
  return rows;
}

/** Drop the cached role mappings (used by tests). */
export function invalidateMcpRoleCache(): void {
  roleCache = null;
}

/**
 * Resolve a user's effective access from the DB, through the SAME shared assembly the web tier
 * uses (`accessFromRows`), including the bootstrap-admin group. Returns null when the user id
 * doesn't resolve to an ACTIVE user.
 */
export async function resolveAccessForUser(
  pool: Pool,
  userId: string,
): Promise<(EffectiveAccess & { userId: string }) | null> {
  const [userRes, mappingRows] = await Promise.all([
    pool.query<UserGroupRow>(SQL_USER_GROUPS_BY_ID, [userId]),
    loadRoleMappings(pool),
  ]);
  const resolved = accessFromRows(userRes.rows, mappingRows, process.env.SKILLY_BOOTSTRAP_ADMIN_GROUP);
  if (!resolved.userId) return null;
  return { ...resolved, userId: resolved.userId };
}

/**
 * Authenticate an MCP request. One indexed lookup joins the access token to its grant, the grant's
 * client, and the owning user; then roles are resolved fresh.
 *
 * The distinct failure reasons exist for the SYSTEM LOG only (§25) — the client-facing response is
 * always the same 401, so a holder of a leaked token learns nothing about why it failed.
 */
export async function authenticate(pool: Pool, authorizationHeader: string | undefined): Promise<AuthResult> {
  const raw = bearerFromHeader(authorizationHeader);
  if (!raw) return { ok: false, reason: "missing_token" };

  const { rows } = await pool.query<{
    grant_id: string;
    user_id: string;
    client_db_id: string;
    client_name: string;
    expires_at: string;
    expired: boolean;
    grant_revoked: boolean;
    client_blocked: boolean;
    user_active: boolean;
  }>(
    `select g.id            as grant_id,
            g.user_id       as user_id,
            c.id            as client_db_id,
            c.client_name   as client_name,
            t.expires_at    as expires_at,
            (t.expires_at <= now())        as expired,
            (g.revoked_at is not null)     as grant_revoked,
            (c.blocked_at is not null)     as client_blocked,
            (u.status = 'active')          as user_active
       from oauth_tokens t
       join oauth_grants g  on g.id = t.grant_id
       join oauth_clients c on c.id = g.client_id
       join users u         on u.id = g.user_id
      where t.kind = 'access' and t.hashed_token = $1`,
    [hashToken(raw)],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "mcp_token_invalid" };
  // Order matters only for the log: report the most specific cause we know.
  if (row.grant_revoked) return { ok: false, reason: "mcp_grant_revoked" };
  if (row.client_blocked) return { ok: false, reason: "mcp_client_blocked" };
  if (!row.user_active) return { ok: false, reason: "mcp_owner_inactive" };
  if (row.expired) return { ok: false, reason: "mcp_token_expired" };

  const access = await resolveAccessForUser(pool, row.user_id);
  // A user who went inactive between the join above and here (or whose row vanished) has no
  // access — treat it exactly like an inactive owner rather than falling back to "no roles".
  if (!access) return { ok: false, reason: "mcp_owner_inactive" };

  // Touch the grant + client so the /mcp Connections list and the admin client list can show
  // "last used", and so the 7-day prune of never-used registrations is accurate. Fire-and-forget:
  // a failed touch must never fail the call.
  //
  // TWO separate statements on purpose: node-postgres cannot send a multi-statement string with
  // bound parameters (the extended protocol rejects it), so a `a; b` query here would fail on
  // every request — and, being fire-and-forget, would fail SILENTLY, leaving every connection
  // reading "never used" forever.
  void pool
    .query(`update oauth_grants set last_used_at = now() where id = $1`, [row.grant_id])
    .then(() => pool.query(`update oauth_clients set last_used_at = now() where id = $1`, [row.client_db_id]))
    .catch(() => {});

  return {
    ok: true,
    caller: {
      userId: access.userId,
      access,
      grantId: row.grant_id,
      clientName: row.client_name,
      clientDbId: row.client_db_id,
    },
  };
}
