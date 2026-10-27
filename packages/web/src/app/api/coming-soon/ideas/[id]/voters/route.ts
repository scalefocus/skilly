// The "Upvoted by" list of a Coming soon item (SKILLY_SPEC.md §60.3, §60.11).
// GET → { voters, votersTotal, hiddenCount }: the voters the caller may see, newest vote first, at
// most 100 (the caller themself included, marked `onlyYou` while they hide their votes). Hidden
// voters are only counted. 404 for anything but a published idea, like the vote route.
import { getIdeaVoters } from "../../../../../../lib/ideas";
import { ideasCaller, isIdeaId, notFound } from "../../../../../../lib/ideasRoute";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const caller = await ideasCaller();
  if (!caller.ok) return caller.res;
  const { id } = await ctx.params;
  if (!isIdeaId(id)) return notFound();
  const r = await getIdeaVoters(caller.viewer.userId, id);
  return r.ok ? Response.json({ voters: r.voters, votersTotal: r.votersTotal, hiddenCount: r.hiddenCount }) : notFound();
}
