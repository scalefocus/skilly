// Administration → Content risk (SKILLY_SPEC.md §37.8): active versions that are flagged (the
// default) or noted, filterable by namespace and rule. Platform admins only.
import { currentAccess } from "../../../../lib/guard";
import { listContentRisk } from "../../../../lib/contentRisk";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access?.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const p = new URL(req.url).searchParams;
  const status = p.get("status");
  const rows = await listContentRisk({
    status: status === "noted" || status === "all" ? status : "flagged",
    ns: p.get("ns"),
    rule: p.get("rule"),
  });
  return Response.json({ rows });
}
