// Place a hype on a skill (SKILLY_SPEC.md §50.2 / §50.10). POST, no body.
// 201 { points, score, hypeCount, remaining, nextAt } · 404 invisible / archived / feature off
// (the same 404 as search — never a probe) · 409 { reason, nextAt } on a refusal.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { findSkill } from "../../../../../../lib/catalog";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";
import { getHypeSettings, placeHype } from "../../../../../../lib/hype";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("hype", access.userId, 30);
  if (limited) return limited;

  const settings = await getHypeSettings();
  if (!settings.enabled) return Response.json({ error: "not found" }, { status: 404 });
  const { ns, slug } = await ctx.params;
  const skill = await findSkill(ns, slug);
  if (!skill || skill.status === "archived" || !isSkillVisible(access, skill)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const r = await placeHype(access.userId, skill.id, settings);
  if (r.ok) {
    const { ok: _ok, ...body } = r;
    return Response.json(body, { status: 201 });
  }
  if (r.status === 404) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ error: r.reason, reason: r.reason, nextAt: r.nextAt }, { status: 409 });
}
