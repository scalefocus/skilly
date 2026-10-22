// Delete any idea the admin page shows, for good (SKILLY_SPEC.md §60.5). POST { reason?, expectedUpdatedAt? }
// → 204 · 404 unknown, withdrawn or already deleted · 409 a pending idea changed since loaded · 422 reason
// too long. Votes cascade; the author's notifications about it go; nobody is told. Platform admin only;
// audited `idea.deleted` with a snapshot of the row.
import { deleteIdea } from "../../../../../../lib/ideas";
import { ideaResultResponse, ideasAdminCaller, isIdeaId, jsonBody, notFound } from "../../../../../../lib/ideasRoute";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await ideasAdminCaller();
  if (!caller.ok) return caller.res;
  const { id } = await ctx.params;
  if (!isIdeaId(id)) return notFound();
  const body = await jsonBody(req);
  return ideaResultResponse(await deleteIdea(caller.userId, id, { reason: body.reason, expectedUpdatedAt: body.expectedUpdatedAt }));
}
