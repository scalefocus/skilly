// The full in-window hyper list of a skill, newest first (SKILLY_SPEC.md §50.6 / §50.10) — the
// "+N" expansion on the detail page and the board. Visibility-checked like the skill itself; 404
// while the feature is off.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { findSkill } from "../../../../../../lib/catalog";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";
import { getHypeSettings, listHypers } from "../../../../../../lib/hype";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  const limited = enforceRateLimit("hypers", access.userId ?? oid, 120);
  if (limited) return limited;
  if (!(await getHypeSettings()).enabled) return Response.json({ error: "not found" }, { status: 404 });
  const { ns, slug } = await ctx.params;
  const skill = await findSkill(ns, slug);
  if (!skill || skill.status === "archived" || !isSkillVisible(access, skill)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json({ hypers: await listHypers(skill.id) });
}
