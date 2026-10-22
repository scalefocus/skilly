// Close a published idea with an outcome (SKILLY_SPEC.md §60.5). POST { outcome, note? } → 204 · 404 ·
// 409 not published / feature off · 422 bad outcome or note. Deletes the idea's votes; Shipped awards
// Made It Real. Platform admin only; audited `idea.closed`.
import { closeIdea } from "../../../../../../lib/ideas";
import { ideaResultResponse, ideasAdminCaller, isIdeaId, jsonBody, notFound } from "../../../../../../lib/ideasRoute";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await ideasAdminCaller(true);
  if (!caller.ok) return caller.res;
  const { id } = await ctx.params;
  if (!isIdeaId(id)) return notFound();
  const body = await jsonBody(req);
  return ideaResultResponse(await closeIdea(caller.userId, id, { outcome: body.outcome, note: body.note }));
}
