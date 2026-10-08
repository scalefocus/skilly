// Agree with or dismiss one AI pre-review finding on a published version (SKILLY_SPEC.md §46.7,
// §46.11). Override authority only. 422 unknown_finding when the fingerprint is not in the
// version's current run. Append-only; audited ai_prereview.finding_dispositioned.
import { currentAccess } from "../../../../../../../lib/guard";
import { findSkill } from "../../../../../../../lib/catalog";
import { withSystemLog } from "../../../../../../../lib/apiLog";
import { enforceRateLimit } from "../../../../../../../lib/ratelimit";
import { dispositionVersionFinding } from "../../../../../../../lib/aiPrereview";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export const POST = withSystemLog("/api/skills/:ns/:slug/ai-prereview/dispositions", async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { ns, slug } = await ctx.params;
  const skill = await findSkill(ns, slug);
  if (!skill || skill.status !== "active" || !isSkillVisible(access, skill)) return Response.json({ error: "not found" }, { status: 404 });
  const limited = enforceRateLimit("ai-prereview-disposition", access.userId, 60);
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await dispositionVersionFinding(access, access.userId, { id: skill.id, namespaceId: skill.namespaceId, slug: skill.slug }, body && typeof body === "object" ? body : {});
  return r.ok ? Response.json(r.value, { status: 201 }) : Response.json({ error: r.error }, { status: r.status });
});
