// Rate a skill 1-5 stars (PUT upsert) or revoke (DELETE). Visibility-enforced identically
// to search — restricted skills return the same 404, never 403. SKILLY_SPEC.md §18.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { findSkill, latestStableSemver } from "../../../../../../lib/catalog";
import { setRating, clearRating } from "../../../../../../lib/ratings";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

async function authorize(ns: string, slug: string) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return { error: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  const access = await resolveUserAccess(oid);
  if (!access.userId) return { error: Response.json({ error: "unknown user" }, { status: 403 }) };

  const skill = await findSkill(ns, slug);
  // Archived skills are out of the catalog; restricted skills must not leak (#3) — same 404.
  if (!skill || skill.status === "archived") return { error: Response.json({ error: "not found" }, { status: 404 }) };
  if (!isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility })) {
    return { error: Response.json({ error: "not found" }, { status: 404 }) };
  }
  return { userId: access.userId, skill };
}

export async function PUT(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const a = await authorize((await ctx.params).ns, (await ctx.params).slug);
  if ("error" in a) return a.error;

  const limited = enforceRateLimit("rating", a.userId, 60);
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as { stars?: unknown };
  const stars = body.stars;
  if (typeof stars !== "number" || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    return Response.json({ error: "stars must be an integer between 1 and 5" }, { status: 422 });
  }

  const ratedSemver = await latestStableSemver(a.skill.id);
  await setRating(a.userId, a.skill.id, stars, ratedSemver);
  return Response.json({ ok: true, stars });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const a = await authorize((await ctx.params).ns, (await ctx.params).slug);
  if ("error" in a) return a.error;

  const limited = enforceRateLimit("rating", a.userId, 60);
  if (limited) return limited;

  await clearRating(a.userId, a.skill.id);
  return Response.json({ ok: true, stars: null });
}
