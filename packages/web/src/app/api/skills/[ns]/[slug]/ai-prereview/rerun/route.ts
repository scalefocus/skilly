// Run (or re-run) a published version's AI pre-review from the owner card (SKILLY_SPEC.md §46.8,
// §46.11). Override authority only (namespace admin of the skill's namespace, or a platform admin).
// 409 already_pending / ai_prereview_unavailable. Audited ai_prereview.rerun_requested.
import { currentAccess } from "../../../../../../../lib/guard";
import { findSkill } from "../../../../../../../lib/catalog";
import { withSystemLog } from "../../../../../../../lib/apiLog";
import { enforceRateLimit } from "../../../../../../../lib/ratelimit";
import { rerunVersionPrereview } from "../../../../../../../lib/aiPrereview";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export const POST = withSystemLog("/api/skills/:ns/:slug/ai-prereview/rerun", async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { ns, slug } = await ctx.params;
  const skill = await findSkill(ns, slug);
  if (!skill || skill.status !== "active" || !isSkillVisible(access, skill)) return Response.json({ error: "not found" }, { status: 404 });
  const limited = enforceRateLimit("ai-prereview-rerun", access.userId, 5);
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as { semver?: unknown } | null;
  const r = await rerunVersionPrereview(access, access.userId, { id: skill.id, namespaceId: skill.namespaceId, slug: skill.slug }, body?.semver);
  return r.ok ? Response.json(r.value, { status: 202 }) : Response.json({ error: r.error }, { status: r.status });
});
