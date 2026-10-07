// The §44 draft plan: which files would be sent to the AI, removed, or skipped (and why). No AI
// call. Same eligibility as the run (404 visibility, 403 role, 409 ai_draft_unavailable).
// SKILLY_SPEC.md §44.5.
import { currentAccess } from "../../../../../../../../lib/guard";
import { withSystemLog } from "../../../../../../../../lib/apiLog";
import { loadDraftContext, draftPlan } from "../../../../../../../../lib/qualityDraft";

export const dynamic = "force-dynamic";

export const GET = withSystemLog("/api/skills/[ns]/[slug]/quality/draft/plan", async function GET(_req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { ns, slug } = await ctx.params;
  const r = await loadDraftContext(access, ns, slug);
  if (!r.ok) return Response.json({ error: r.status === 409 ? "ai_draft_unavailable" : r.error, reason: r.reason ?? null, message: r.error }, { status: r.status });
  try {
    const { plan } = await draftPlan(r.ctx);
    return Response.json({ baseSemver: r.ctx.semver, files: plan });
  } catch (err) {
    return Response.json({ error: `couldn't read the stored bundle: ${String((err as Error)?.message ?? err)}` }, { status: 503 });
  }
});
