// Edit a published idea (SKILLY_SPEC.md §60.5). PATCH { title?, description? } → 204 · 404 · 409 not
// published (or the feature is off) · 422 bad input. Platform admin only; audited `idea.updated`.
import { editPublishedIdea } from "../../../../../lib/ideas";
import { ideaResultResponse, ideasAdminCaller, isIdeaId, jsonBody, notFound } from "../../../../../lib/ideasRoute";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await ideasAdminCaller(true);
  if (!caller.ok) return caller.res;
  const { id } = await ctx.params;
  if (!isIdeaId(id)) return notFound();
  const body = await jsonBody(req);
  return ideaResultResponse(await editPublishedIdea(caller.userId, id, { title: body.title, description: body.description }));
}
