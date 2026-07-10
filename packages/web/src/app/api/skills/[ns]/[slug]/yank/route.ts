// Yank / restore a version. Namespace Admin (own) or Platform Admin (any). SKILLY_SPEC.md §7.
import { currentAccess } from "../../../../../../lib/guard";
import { pool } from "../../../../../../lib/db";
import { setVersionYanked } from "../../../../../../lib/manage";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("yank", access.userId, 60);
  if (limited) return limited;
  const body = (await req.json()) as { semver: string; yanked?: boolean };
  const r = await setVersionYanked(pool, {
    access,
    actorUserId: access.userId,
    namespaceSlug: (await ctx.params).ns,
    skillSlug: (await ctx.params).slug,
    semver: body.semver,
    yanked: body.yanked ?? true,
  });
  return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: r.status });
}
