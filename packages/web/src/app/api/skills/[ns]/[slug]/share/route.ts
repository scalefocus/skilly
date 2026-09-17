// Mint a signed share link (§33.6). Visibility-checked at mint time — a 7-day-TTL token that
// unlocks this skill's Open Graph metadata for anyone who follows the link, without requiring
// sign-in to see the unfurl. The page itself stays client-gated (§2); the link only changes what
// a crawler's <head> sees. The raw token is never stored (only its hash), so each Share click
// mints a fresh token rather than trying to hand back a previous one.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { findSkill } from "../../../../../../lib/catalog";
import { pool } from "../../../../../../lib/db";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";
import { withSystemLog } from "../../../../../../lib/apiLog";
import { appendAudit } from "../../../../../../lib/audit";
import { generateToken, hashToken } from "@skilly/shared";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

const SHARE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  if (!skill || (skill.status === "active" && !isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility }))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const raw = generateToken(24);
  const expiresAt = new Date(Date.now() + SHARE_LINK_TTL_MS);
  await pool.query(
    `insert into skill_share_links (hashed_token, skill_id, created_by, expires_at) values ($1, $2, $3, $4)`,
    [hashToken(raw), skill.id, access.userId, expiresAt.toISOString()],
  );
  await appendAudit(pool, {
    actorUserId: access.userId,
    action: "skill.share_link_created",
    targetType: "skill",
    targetId: skill.id,
    namespaceId: skill.namespaceId,
    after: { expiresAt: expiresAt.toISOString() },
  });

  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
  return Response.json({ url: `${base}/skills/${ns}/${slug}?s=${raw}`, expiresAt: expiresAt.toISOString() }, { status: 201 });
});
