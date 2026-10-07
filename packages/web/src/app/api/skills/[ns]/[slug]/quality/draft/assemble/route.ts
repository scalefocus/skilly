// Assemble an AI quality draft into a staged hosted bundle (SKILLY_SPEC.md §44.7): every kept change
// must be vouched for by the run token; the base version's files plus the changes go through the
// ordinary upload pipeline. Returns the upload response + aiDraftToken + the pre-filled note.
import { currentAccess } from "../../../../../../../../lib/guard";
import { withSystemLog } from "../../../../../../../../lib/apiLog";
import { loadDraftContext, assembleDraft, parseAssembleChanges } from "../../../../../../../../lib/qualityDraft";
import { enforceRateLimit } from "../../../../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

export const POST = withSystemLog("/api/skills/[ns]/[slug]/quality/draft/assemble", async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { ns, slug } = await ctx.params;
  const r = await loadDraftContext(access, ns, slug);
  if (!r.ok) return Response.json({ error: r.status === 409 ? "ai_draft_unavailable" : r.error, reason: r.reason ?? null, message: r.error }, { status: r.status });
  // Shares the uploads bucket: this is an upload.
  const limited = enforceRateLimit("uploads", access.userId, 20);
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as { runToken?: unknown; baseSemver?: unknown; changes?: unknown } | null;
  const changes = parseAssembleChanges(body?.changes);
  if (!body || !changes) return Response.json({ error: "changes must be a non-empty list of { path, action: 'modify' (with content) | 'delete' }" }, { status: 422 });
  return assembleDraft({ ...access, userId: access.userId }, r.ctx, { runToken: body.runToken, baseSemver: body.baseSemver, changes });
});
