// Archive / restore a skill. Namespace Admin (own) or Platform Admin (any). SKILLY_SPEC.md §7.
import { currentAccess } from "../../../../../../lib/guard";
import { pool } from "../../../../../../lib/db";
import { setSkillArchived } from "../../../../../../lib/manage";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("archive", access.userId, 60);
  if (limited) return limited;
  const body = (await req.json()) as { archived?: boolean };
  const r = await setSkillArchived(pool, {
    access,
    actorUserId: access.userId,
    namespaceSlug: (await ctx.params).ns,
    skillSlug: (await ctx.params).slug,
    archived: body.archived ?? true,
  });
  return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: r.status });
}
