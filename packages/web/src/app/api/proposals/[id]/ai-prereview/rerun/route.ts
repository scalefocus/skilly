// Re-run a proposal's AI pre-review (SKILLY_SPEC.md §46.11): reviewers only, open proposals only,
// bypasses the cache. 409 already_pending / ai_prereview_unavailable. Audited
// ai_prereview.rerun_requested. The worker runs it on its next pass.
import { currentAccess } from "../../../../../../lib/guard";
import { withSystemLog } from "../../../../../../lib/apiLog";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";
import { rerunProposalPrereview } from "../../../../../../lib/aiPrereview";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = withSystemLog("/api/proposals/:id/ai-prereview/rerun", async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const limited = enforceRateLimit("ai-prereview-rerun", access.userId, 5);
  if (limited) return limited;
  const r = await rerunProposalPrereview(access, access.userId, id);
  return r.ok ? Response.json(r.value, { status: 202 }) : Response.json({ error: r.error }, { status: r.status });
});
