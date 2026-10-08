// Agree with or dismiss one AI pre-review finding on a proposal (SKILLY_SPEC.md §46.7, §46.11):
// reviewers only, open proposals only. 422 unknown_finding when the fingerprint is not in the
// current run. Append-only; audited ai_prereview.finding_dispositioned.
import { currentAccess } from "../../../../../../lib/guard";
import { withSystemLog } from "../../../../../../lib/apiLog";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";
import { dispositionProposalFinding } from "../../../../../../lib/aiPrereview";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = withSystemLog("/api/proposals/:id/ai-prereview/dispositions", async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const limited = enforceRateLimit("ai-prereview-disposition", access.userId, 60);
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await dispositionProposalFinding(access, access.userId, id, body && typeof body === "object" ? body : {});
  return r.ok ? Response.json(r.value, { status: 201 }) : Response.json({ error: r.error }, { status: r.status });
});
