// Mint a signed share link (§33.6). Visibility-checked at mint time — a 7-day-TTL token that
// unlocks this skill's Open Graph metadata for anyone who follows the link, without requiring
// sign-in to see the unfurl. The page itself stays client-gated (§2); the link only changes what
// a crawler's <head> sees. The raw token is never stored (only its hash), so each Share click
// mints a fresh token rather than trying to hand back a previous one.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { findSkill } from "../../../../../../lib/catalog";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";
import { withSystemLog } from "../../../../../../lib/apiLog";
import { mintShareLink } from "../../../../../../lib/shareLinks";
import { webBaseUrl } from "../../../../../../lib/baseUrl";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export const POST = withSystemLog("/api/skills/[ns]/[slug]/share", async function POST(_req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("share-link", access.userId, 20);
  if (limited) return limited;

  const { ns, slug } = await ctx.params;
  const skill = await findSkill(ns, slug);
  // No leak (§33.6/invariant #3): a restricted skill the caller can't see 404s exactly like an
  // unknown slug.
  // §49.4: archived or not, an invisible skill is a 404 — the status is never consulted first.
  if (!skill || !isSkillVisible(access, skill)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const { token: raw, expiresAt } = await mintShareLink(access.userId, skill);

  // §33.6: the external base URL; none configured → the bare path, which the Share button resolves
  // against the browser's origin before copying.
  return Response.json({ url: `${webBaseUrl()}/skills/${ns}/${slug}?s=${raw}`, expiresAt: expiresAt.toISOString() }, { status: 201 });
});
