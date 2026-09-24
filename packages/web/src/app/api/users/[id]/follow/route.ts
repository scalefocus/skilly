// Follow / unfollow a person (SKILLY_SPEC.md §35.10). PUT follows (400 self, 404 unknown / erased /
// inactive, 409 follows_disabled while the target has paused follows); DELETE unfollows and is
// always allowed. Both idempotent, both at the watch endpoint's per-user budget.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../lib/access";
import { enforceRateLimit } from "../../../../../lib/ratelimit";
import { followUser, unfollowUser, type FollowResult } from "../../../../../lib/follows";
import { FOLLOW_RATE_LIMIT_PER_MIN } from "@skilly/shared/follows";

export const dynamic = "force-dynamic";

async function handle(ctx: { params: Promise<{ id: string }> }, op: (me: string, target: string) => Promise<FollowResult>) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("follow", access.userId, FOLLOW_RATE_LIMIT_PER_MIN);
  if (limited) return limited;
  const r = await op(access.userId, (await ctx.params).id);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json({ following: r.following });
}

export function PUT(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(ctx, followUser);
}

export function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(ctx, unfollowUser);
}
