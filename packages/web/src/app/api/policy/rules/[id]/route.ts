// One policy rule (SKILLY_SPEC.md §47.3, §47.11). PATCH edits the text — a new immutable revision,
// which re-queues the checks in its scope. DELETE removes a rule no check ever cited (409 `cited`
// otherwise — disable it instead). The rule's scope admins only. Audited.
import { currentAccess } from "../../../../../lib/guard";
import { deleteRule, updateRule } from "../../../../../lib/policy";
import { enforceRateLimit } from "../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("policy-rules", access.userId, 30);
  if (limited) return limited;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "rule not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const r = await updateRule(access, access.userId, id, body);
  return r.ok ? Response.json({ revisionNo: r.revisionNo, changed: r.changed }) : Response.json({ error: r.error, code: r.code }, { status: r.status });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "rule not found" }, { status: 404 });
  const r = await deleteRule(access, access.userId, id);
  return r.ok ? new Response(null, { status: 204 }) : Response.json({ error: r.error, code: r.code }, { status: r.status });
}
