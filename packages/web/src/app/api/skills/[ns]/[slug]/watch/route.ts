// Follow / unfollow a skill (visibility-enforced). POST { watch: boolean }.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { findSkill } from "../../../../../../lib/catalog";
import { setWatch } from "../../../../../../lib/watch";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("watch", access.userId, 120);
  if (limited) return limited;

  const skill = await findSkill((await ctx.params).ns, (await ctx.params).slug);
  if (!skill || skill.status === "archived") return Response.json({ error: "not found" }, { status: 404 });
  if (!isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility })) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { watch?: boolean };
  await setWatch(access.userId, skill.id, body.watch !== false);
  return Response.json({ ok: true, watching: body.watch !== false });
}
