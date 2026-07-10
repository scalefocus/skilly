// Feature / un-feature a skill (platform-admin-only homepage spotlight). SKILLY_SPEC.md §7.
import { currentAccess } from "../../../../../../lib/guard";
import { pool } from "../../../../../../lib/db";
import { setSkillFeatured } from "../../../../../../lib/manage";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("feature", access.userId, 60);
  if (limited) return limited;
  const body = (await req.json()) as { featured?: boolean };
  const r = await setSkillFeatured(pool, {
    access,
    actorUserId: access.userId,
    namespaceSlug: (await ctx.params).ns,
    skillSlug: (await ctx.params).slug,
    featured: body.featured ?? true,
  });
  return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: r.status });
}
