// Mark / unmark a skill as Official (platform-admin-only endorsement). SKILLY_SPEC.md §7.
import { currentAccess } from "../../../../../../lib/guard";
import { pool } from "../../../../../../lib/db";
import { setSkillOfficial } from "../../../../../../lib/manage";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("official", access.userId, 60);
  if (limited) return limited;
  const body = (await req.json()) as { official?: boolean };
  const r = await setSkillOfficial(pool, {
    access,
    actorUserId: access.userId,
    namespaceSlug: (await ctx.params).ns,
    skillSlug: (await ctx.params).slug,
    official: body.official ?? true,
  });
  return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: r.status });
}
