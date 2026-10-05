// Acknowledge a flagged version's content-risk findings (SKILLY_SPEC.md §37.6). Override authority
// only (namespace admin of the skill's namespace, or a platform admin); 409 unless flagged. Audited
// as skill.content_risk_acknowledged.
import { currentAccess } from "../../../../../../../lib/guard";
import { findSkill } from "../../../../../../../lib/catalog";
import { acknowledgeContentRisk } from "../../../../../../../lib/contentRisk";
import { enforceRateLimit } from "../../../../../../../lib/ratelimit";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("content-risk-ack", access.userId, 60);
  if (limited) return limited;
  const { ns, slug } = await ctx.params;
  const skill = await findSkill(ns, slug);
  if (!skill || skill.status !== "active" || !isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility })) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as { semver?: unknown; note?: unknown };
  if (typeof body.semver !== "string" || !body.semver) return Response.json({ error: "semver is required" }, { status: 422 });
  const note = typeof body.note === "string" ? body.note : null;
  const r = await acknowledgeContentRisk(access, access.userId, { id: skill.id, namespaceId: skill.namespaceId, slug: skill.slug }, body.semver, note);
  return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: r.status });
}
