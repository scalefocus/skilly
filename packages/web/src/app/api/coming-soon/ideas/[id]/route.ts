// The proposer's own pending idea (SKILLY_SPEC.md §60.4). PATCH { description } edits it, DELETE
// withdraws it. 204 · 404 not theirs (or the feature is off) · 409 no longer pending · 422 bad length.
import { editOwnIdea, withdrawOwnIdea } from "../../../../../lib/ideas";
import { ideaResultResponse, ideasCaller, isIdeaId, jsonBody, notFound } from "../../../../../lib/ideasRoute";
import { enforceRateLimit } from "../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const caller = await ideasCaller();
  if (!caller.ok) return caller.res;
  const { id } = await ctx.params;
  if (!isIdeaId(id)) return notFound();
  const limited = enforceRateLimit("idea-write", caller.viewer.userId, 30);
  if (limited) return limited;
  const body = await jsonBody(req);
  return ideaResultResponse(await editOwnIdea(caller.viewer.userId, id, body.description));
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const caller = await ideasCaller();
  if (!caller.ok) return caller.res;
  const { id } = await ctx.params;
  if (!isIdeaId(id)) return notFound();
  return ideaResultResponse(await withdrawOwnIdea(caller.viewer.userId, id));
}
