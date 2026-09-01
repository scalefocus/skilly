// Marketplace tokens — the consumer handle for a Claude Code plugin marketplace (§30.4).
// The structural twin of lib/installs.ts: same derived states, same TTL rules, same
// generate-purges-unclaimed rule, same reactivate, same hard-delete-on-remove. The one
// difference is the scope: a marketplace (public, or one namespace) rather than a skill.
import {
  PUBLIC_SCOPE,
  generateToken,
  hashToken,
  marketplaceName,
  type MarketplaceScope,
} from "@skilly/shared";
import { pool } from "./db";
import { M } from "./metrics";

/** A namespace marketplace is restricted content: minting requires access to that namespace. */
export interface MintTarget {
  scope: MarketplaceScope;
  namespaceId: string | null;
}

/**
 * Mint a new (unused) marketplace token. `expiresAt` null = never.
 *
 * Supersedes the caller's prior UNCLAIMED tokens for the SAME marketplace — regenerating a
 * command (changed expiry, or just re-clicking) invalidates any earlier one that was never used,
 * so unused valid tokens don't pile up. CLAIMED ones are the durable handle and survive. The
 * scope match is exact, so a public token never purges a namespace one. §30.4.
 */
export async function mintMarketplaceToken(
  userId: string,
  target: MintTarget,
  expiresAt: Date | null,
): Promise<{ raw: string }> {
  const raw = generateToken();
  const scopeKind = target.scope.kind;
  const namespaceId = scopeKind === "namespace" ? target.namespaceId : null;
  await pool.query(
    `delete from tokens
      where user_id = $1 and type = 'marketplace' and used_at is null
        and marketplace_scope = $2 and namespace_id is not distinct from $3`,
    [userId, scopeKind, namespaceId],
  );
  await pool.query(
    `insert into tokens (user_id, type, hashed_token, marketplace_scope, namespace_id, scope, expires_at, is_system)
     values ($1, 'marketplace', $2, $3, $4, $5::jsonb, $6, false)`,
    [userId, hashToken(raw), scopeKind, namespaceId, JSON.stringify({ marketplace: scopeKind, namespaceId }), expiresAt],
  );
  M.tokensMinted.inc({ type: "marketplace" });
  return { raw };
}

export interface MarketplaceView {
  id: string;
  scope: "public" | "namespace";
  /** Namespace slug for a namespace marketplace; null for the public one. */
  namespaceSlug: string | null;
  /** The public-facing marketplace name, e.g. `skilly-team-a`. */
  name: string;
  addedAt: string; // used_at
  expiresAt: string | null; // null = never
  inactive: boolean; // used but past expiry
  clientUserAgent: string | null;
  clientIp: string | null;
  /** False once the marketplace has been switched off — the URL no longer resolves (§30.6). */
  stillServed: boolean;
}

/**
 * A user's USED marketplace tokens — the "Added marketplaces" page (§30.6). Generated-but-unused
 * tokens are ephemeral and not listed, exactly as on the Installed skills page.
 */
export async function listMarketplaces(userId: string, prefix: string): Promise<MarketplaceView[]> {
  const { rows } = await pool.query<{
    id: string; marketplace_scope: "public" | "namespace"; ns_slug: string | null;
    used_at: string; expires_at: string | null; inactive: boolean;
    client_user_agent: string | null; client_ip: string | null;
    ns_enabled: boolean | null; public_enabled: boolean;
  }>(
    `select t.id, t.marketplace_scope, n.slug as ns_slug, t.used_at, t.expires_at,
            t.client_user_agent, t.client_ip,
            (t.expires_at is not null and t.expires_at <= now()) as inactive,
            n.marketplace_enabled as ns_enabled,
            coalesce((select value = 'true'::jsonb from platform_settings where key = 'marketplace_public_enabled'), false) as public_enabled
       from tokens t
       left join namespaces n on n.id = t.namespace_id
      where t.user_id = $1 and t.type = 'marketplace' and t.used_at is not null
      order by t.marketplace_scope asc, lower(coalesce(n.slug, '')) asc, t.used_at desc`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    scope: r.marketplace_scope,
    namespaceSlug: r.ns_slug,
    name: marketplaceName(prefix, r.marketplace_scope === "public" ? PUBLIC_SCOPE : { kind: "namespace", namespaceSlug: r.ns_slug ?? "" }),
    addedAt: r.used_at,
    expiresAt: r.expires_at,
    inactive: r.inactive,
    clientUserAgent: r.client_user_agent,
    clientIp: r.client_ip,
    stillServed: r.marketplace_scope === "public" ? r.public_enabled : r.ns_enabled === true,
  }));
}

/** Remove a marketplace: hard-delete the token, so the URL is refused. Owner-scoped. */
export async function removeMarketplace(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `delete from tokens where id = $1 and user_id = $2 and type = 'marketplace'`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Reactivate an INACTIVE marketplace by setting a new expiry on the SAME token, so the user's
 * existing URL works again — no re-add in Claude Code. Owner-scoped; only matches rows that are
 * currently used + expired, so active tokens and other users' rows are untouched.
 */
export async function reactivateMarketplace(userId: string, id: string, expiresAt: Date | null): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update tokens set expires_at = $3
      where id = $1 and user_id = $2 and type = 'marketplace'
        and used_at is not null and expires_at is not null and expires_at <= now()`,
    [id, userId, expiresAt],
  );
  return (rowCount ?? 0) > 0;
}

/** Revoke every token for one namespace's marketplace (called when its toggle goes off, §30.6). */
export async function revokeNamespaceMarketplaceTokens(namespaceId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from tokens where type = 'marketplace' and namespace_id = $1`,
    [namespaceId],
  );
  return rowCount ?? 0;
}

/** How many skills a marketplace currently publishes — shown next to the toggle (§30.6).
 *  Mirrors the worker's qualifying-skill rule so the count never disagrees with the repo. */
export async function marketplaceSkillCount(scope: MarketplaceScope, namespaceId: string | null): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(distinct s.id) as n
       from skills s
       join skill_versions sv on sv.skill_id = s.id and sv.status = 'active' and sv.git_published
      where s.status = 'active'
        and ${scope.kind === "public" ? `s.visibility = 'org'` : `s.visibility = 'namespace' and s.namespace_id = $1`}`,
    scope.kind === "public" ? [] : [namespaceId],
  );
  return Number(rows[0]?.n ?? 0);
}
