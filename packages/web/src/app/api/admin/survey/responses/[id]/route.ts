// Delete one feedback-survey response, answers included (SKILLY_SPEC.md §36.9 / §36.10). Platform
// admins only; audited as `survey.response_deleted` without the text (§36.11).
import { currentAccess } from "../../../../../../lib/guard";
import { deleteSurveyResponse } from "../../../../../../lib/survey";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.userId || !access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  if (!(await deleteSurveyResponse((await ctx.params).id, access.userId))) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true });
}
