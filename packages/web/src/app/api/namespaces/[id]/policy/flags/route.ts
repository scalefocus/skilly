// One namespace's flagged / noted versions and its Shadow preview (SKILLY_SPEC.md §47.9) — the
// list under the Policy rules section of the Namespace administration page. That namespace's
// admins and platform admins only; anyone else gets 404 (like the settings route).
import { currentAccess } from "../../../../../../lib/guard";
import { canManagePolicyScope, listFlagsForNamespace } from "../../../../../../lib/policy";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  if (!UUID.test(id) || !canManagePolicyScope(access, id)) return Response.json({ error: "not found" }, { status: 404 });
  const p = new URL(req.url).searchParams;
  const rows = await listFlagsForNamespace(id, { status: p.get("status"), rule: p.get("rule"), shadow: p.get("shadow") === "1" });
  return Response.json({ rows });
}
