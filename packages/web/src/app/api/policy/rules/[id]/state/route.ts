// Change a policy rule's state — Shadow / Enforced / Disabled (SKILLY_SPEC.md §47.3). Moving to
// Shadow or Enforced re-queues the checks that lack a result for the rule; Disabled takes effect
// at once everywhere. The rule's scope admins only. Audited as policy.rule_state_changed.
import { currentAccess } from "../../../../../../lib/guard";
import { changeRuleState } from "../../../../../../lib/policy";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("policy-rules", access.userId, 30);
  if (limited) return limited;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "rule not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { state?: unknown };
  const r = await changeRuleState(access, access.userId, id, body.state);
  return r.ok ? Response.json({ state: r.state }) : Response.json({ error: r.error, code: r.code }, { status: r.status });
}
