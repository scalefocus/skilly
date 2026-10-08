// A policy rule's revision history, newest first (SKILLY_SPEC.md §47.11). The rule's scope admins only.
import { currentAccess } from "../../../../../../lib/guard";
import { ruleRevisionsForViewer } from "../../../../../../lib/policy";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "rule not found" }, { status: 404 });
  const r = await ruleRevisionsForViewer(access, id);
  return r.ok ? Response.json({ revisions: r.revisions }) : Response.json({ error: r.error }, { status: r.status });
}
