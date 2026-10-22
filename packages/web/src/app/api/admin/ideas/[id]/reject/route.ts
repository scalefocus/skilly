// Reject a pending idea (SKILLY_SPEC.md §60.5). POST { reason?, expectedUpdatedAt } → 204 · 404 ·
// 409 no longer pending / changed since loaded · 422 reason too long. Platform admin only.
import { rejectIdea } from "../../../../../../lib/ideas";
import { ideaResultResponse, ideasAdminCaller, isIdeaId, jsonBody, notFound } from "../../../../../../lib/ideasRoute";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await ideasAdminCaller();
  if (!caller.ok) return caller.res;
  const { id } = await ctx.params;
  if (!isIdeaId(id)) return notFound();
  const body = await jsonBody(req);
  return ideaResultResponse(await rejectIdea(caller.userId, id, { reason: body.reason, expectedUpdatedAt: body.expectedUpdatedAt }));
}
