// Policy rules (SKILLY_SPEC.md §47.11). GET: any signed-in user reads the ENFORCED platform rules
// and, with ?ns=<slug>, that namespace's enforced rules; `&all=1` adds shadow + disabled rules,
// state and history for that scope's admins. POST: create a rule (namespace admins for their
// namespace, platform admins for any scope); new rules start in Shadow. Audited.
import { currentAccess } from "../../../../lib/guard";
import { createRule, listRulesForViewer } from "../../../../lib/policy";
import { enforceRateLimit } from "../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const p = new URL(req.url).searchParams;
  const r = await listRulesForViewer(access, p.get("ns"), p.get("all") === "1");
  return r.ok ? Response.json(r.listing) : Response.json({ error: r.error }, { status: r.status });
}

export async function POST(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("policy-rules", access.userId, 30);
  if (limited) return limited;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const r = await createRule(access, access.userId, body);
  return r.ok ? Response.json({ id: r.id }, { status: 201 }) : Response.json({ error: r.error, code: r.code }, { status: r.status });
}
