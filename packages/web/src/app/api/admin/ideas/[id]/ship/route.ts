// Mark a Planned idea shipped (SKILLY_SPEC.md §60.5) — one way, for ideas closed as Planned before
// v2.41.0. POST → 204 · 404 · 409 not closed as Planned. Awards Made It Real and tells the proposer.
// Platform admin only; audited `idea.marked_shipped`.
import { markIdeaShipped } from "../../../../../../lib/ideas";
import { ideaResultResponse, ideasAdminCaller, isIdeaId, notFound } from "../../../../../../lib/ideasRoute";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await ideasAdminCaller();
  if (!caller.ok) return caller.res;
  const { id } = await ctx.params;
  if (!isIdeaId(id)) return notFound();
  return ideaResultResponse(await markIdeaShipped(caller.userId, id));
}
