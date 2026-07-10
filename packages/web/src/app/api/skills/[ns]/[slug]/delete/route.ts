// Permanently delete an archived skill. Platform Admin only. SKILLY_SPEC.md §7.
import { currentAccess } from "../../../../../../lib/guard";
import { pool } from "../../../../../../lib/db";
import { deleteSkill } from "../../../../../../lib/manage";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("archive", access.userId, 60);
  if (limited) return limited;
  const r = await deleteSkill(pool, {
    access,
    actorUserId: access.userId,
    namespaceSlug: (await ctx.params).ns,
    skillSlug: (await ctx.params).slug,
  });
  return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: r.status });
}
