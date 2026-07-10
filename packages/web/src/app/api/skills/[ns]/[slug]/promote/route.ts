// Promote a skill to the global namespace (creates a platform-admin-reviewed proposal).
// Any member of the owning namespace may initiate. SKILLY_SPEC.md §8.
import { currentAccess } from "../../../../../../lib/guard";
import { pool } from "../../../../../../lib/db";
import { promoteToGlobal } from "../../../../../../lib/proposals";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  // Each promote creates a global proposal that notifies every platform admin — limit it.
  const limited = enforceRateLimit("promote", access.userId, 20);
  if (limited) return limited;
  const r = await promoteToGlobal(pool, {
    access,
    actorUserId: access.userId,
    sourceNamespaceSlug: (await ctx.params).ns,
    sourceSkillSlug: (await ctx.params).slug,
  });
  return r.ok ? Response.json({ proposalId: r.proposalId }, { status: 201 }) : Response.json({ error: r.error }, { status: r.status });
}
