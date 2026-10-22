// Upvote a spec'd Coming soon teaser (SKILLY_SPEC.md §60.6). PUT votes, DELETE un-votes; both
// idempotent → 200 { votes, voted }. 404 for a key not in the list or not for this viewer's audience
// (the same answer, so the route never reveals an admin-only teaser), and while the feature is off.
import { voteTeaser } from "../../../../../../lib/ideas";
import { ideasCaller, notFound } from "../../../../../../lib/ideasRoute";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";
import { isUpcomingKey } from "@skilly/shared/ideas";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string }> };

async function vote(ctx: Ctx, on: boolean): Promise<Response> {
  const caller = await ideasCaller();
  if (!caller.ok) return caller.res;
  const limited = enforceRateLimit("idea-vote", caller.viewer.userId, 120);
  if (limited) return limited;
  const { key } = await ctx.params;
  if (!isUpcomingKey(key)) return notFound();
  const r = await voteTeaser(caller.viewer, key, on);
  return r.ok ? Response.json({ votes: r.votes, voted: r.voted }) : notFound();
}

export async function PUT(_req: Request, ctx: Ctx) {
  return vote(ctx, true);
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return vote(ctx, false);
}
