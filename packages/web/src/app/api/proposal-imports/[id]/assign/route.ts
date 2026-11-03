// *Assign all open* (SKILLY_SPEC.md §65.5): assign every open proposal of one repository import to
// one reviewer in one action. Reviewers of the import's namespace only. One notification for the
// whole import; one audit row per proposal that changed.
import { currentAccess } from "../../../../../lib/guard";
import { pool } from "../../../../../lib/db";
import { assignImport } from "../../../../../lib/reviewAssign";
import { enforceRateLimit } from "../../../../../lib/ratelimit";
import { withSystemLog } from "../../../../../lib/apiLog";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = withSystemLog("/api/proposal-imports/[id]/assign", async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("proposal-action", access.userId, 60);
  if (limited) return limited;
  const id = (await ctx.params).id;
  if (!UUID.test(id)) return Response.json({ error: "import not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { assigneeId?: unknown };
  if (typeof body.assigneeId !== "string" || !UUID.test(body.assigneeId)) {
    return Response.json({ error: "assigneeId must be a user id" }, { status: 422 });
  }
  const result = await assignImport(pool, { importId: id, assigneeId: body.assigneeId, access, actorUserId: access.userId });
  if (!result.ok) return Response.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });
  return Response.json({ assigned: result.assigned, reassigned: result.reassigned });
});
