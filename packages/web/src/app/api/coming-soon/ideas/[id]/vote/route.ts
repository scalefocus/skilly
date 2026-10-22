// Upvote a published idea (SKILLY_SPEC.md §60.6). PUT votes, DELETE un-votes; both idempotent →
// 200 { votes, voted }. 404 for anything but a published idea, and while the feature is off.
import { voteIdea } from "../../../../../../lib/ideas";
import { ideasCaller, isIdeaId, notFound } from "../../../../../../lib/ideasRoute";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function vote(ctx: Ctx, on: boolean): Promise<Response> {
  const caller = await ideasCaller();
  if (!caller.ok) return caller.res;
  const limited = enforceRateLimit("idea-vote", caller.viewer.userId, 120);
  if (limited) return limited;
  const { id } = await ctx.params;
  if (!isIdeaId(id)) return notFound();
  const r = await voteIdea(caller.viewer.userId, id, on);
  return r.ok ? Response.json({ votes: r.votes, voted: r.voted }) : notFound();
}

export async function PUT(_req: Request, ctx: Ctx) {
  return vote(ctx, true);
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return vote(ctx, false);
}
