// Mint a marketplace token and return the copy-paste commands (SKILLY_SPEC.md §30.4/§30.8).
//
// Authority: the PUBLIC marketplace is open to any authenticated user — it carries only
// org-visible skills, so there is nothing to gate. A NAMESPACE marketplace carries restricted
// skills, so it takes the same access the skills themselves take (any role in that namespace).
import { getServerSession } from "next-auth";
import {
  PUBLIC_SCOPE,
  buildMarketplaceAddCommand,
  buildMarketplaceAddCommandPlain,
  buildMarketplaceGitConfigCommand,
  canUseNamespaceMarketplace,
  marketplaceName,
  type MarketplaceScope,
} from "@skilly/shared";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { mintMarketplaceToken } from "../../../../lib/marketplaces";
import { getInstallMaxTtlMonths, getMarketplaceNamePrefix, getMarketplacePublicEnabled, installExpiryCeiling } from "../../../../lib/settings";
import { pool } from "../../../../lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { scope?: string; namespaceSlug?: string; expiresAt?: string | null };

  let scope: MarketplaceScope;
  let namespaceId: string | null = null;
  if (body.scope === "public") {
    if (!(await getMarketplacePublicEnabled())) {
      return Response.json({ error: "the public marketplace is not enabled" }, { status: 404 });
    }
    scope = PUBLIC_SCOPE;
  } else if (body.scope === "namespace" && body.namespaceSlug) {
    const { rows } = await pool.query<{ id: string; marketplace_enabled: boolean }>(
      `select id, marketplace_enabled from namespaces where slug = $1`,
      [body.namespaceSlug],
    );
    const ns = rows[0];
    // A namespace the caller can't see must 404 exactly like one that doesn't exist — the
    // response must never confirm that a restricted namespace exists (invariant #3).
    if (!ns || !canUseNamespaceMarketplace(access, ns.id)) {
      return Response.json({ error: "marketplace not found" }, { status: 404 });
    }
    if (!ns.marketplace_enabled) {
      return Response.json({ error: "this namespace's marketplace is not enabled" }, { status: 404 });
    }
    scope = { kind: "namespace", namespaceSlug: body.namespaceSlug };
    namespaceId = ns.id;
  } else {
    return Response.json({ error: "scope must be 'public' or 'namespace' with a namespaceSlug" }, { status: 422 });
  }

  // Same TTL rules and the same platform-configured horizon as an install token (§30.4).
  let expiresAt: Date | null = null;
  if (body.expiresAt) {
    const d = new Date(body.expiresAt);
    if (Number.isNaN(d.getTime())) return Response.json({ error: "invalid expiry date" }, { status: 422 });
    if (d.getTime() <= Date.now()) return Response.json({ error: "expiry must be in the future" }, { status: 422 });
    const months = await getInstallMaxTtlMonths();
    if (d.getTime() > installExpiryCeiling(months).getTime()) {
      return Response.json({ error: `expiry can be at most ${months} month${months === 1 ? "" : "s"} out — or choose “Never”` }, { status: 422 });
    }
    expiresAt = d;
  }

  const { raw } = await mintMarketplaceToken(access.userId, { scope, namespaceId }, expiresAt);
  const prefix = await getMarketplaceNamePrefix();
  const registryBaseUrl = process.env.SKILLY_REGISTRY_URL ?? new URL(req.url).origin;

  return Response.json({
    name: marketplaceName(prefix, scope),
    // Primary: the token embedded in the clone URL, exactly as §9 does for skills.
    command: buildMarketplaceAddCommand({ registryBaseUrl, scope, token: raw }),
    // Fallback for consumers whose BACKGROUND marketplace updates fail: Claude Code disables git
    // credential helpers for those, so a global URL rewrite carries the credential instead. One
    // rewrite covers every marketplace on this host. §30.4
    gitConfigCommand: buildMarketplaceGitConfigCommand({ registryBaseUrl, scope, token: raw }),
    plainCommand: buildMarketplaceAddCommandPlain({ registryBaseUrl, scope }),
    expiresAt: expiresAt?.toISOString() ?? null,
  });
}
