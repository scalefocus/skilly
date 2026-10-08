// Administration → Policy (SKILLY_SPEC.md §47.9): published versions flagged (the default) or
// noted by an enforced rule, filterable by namespace and rule; `?shadow=1` is the Shadow preview —
// what each shadow rule would flag. Platform admins only.
import { currentAccess } from "../../../../lib/guard";
import { listFlagsForAdmin } from "../../../../lib/policy";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access?.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const p = new URL(req.url).searchParams;
  const r = await listFlagsForAdmin({ status: p.get("status"), ns: p.get("ns"), rule: p.get("rule"), shadow: p.get("shadow") === "1" });
  return r.ok ? Response.json({ rows: r.rows }) : Response.json({ error: r.error }, { status: r.status });
}
