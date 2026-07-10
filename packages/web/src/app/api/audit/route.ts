// Scoped audit log reader. Platform admins see all; namespace admins see their namespaces.
import { currentAccess } from "../../../lib/guard";
import { auditScope, listAudit } from "../../../lib/audit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const scope = auditScope(access);
  if (!scope.all && scope.namespaceIds.length === 0) {
    return Response.json({ error: "audit access requires platform or namespace admin" }, { status: 403 });
  }

  const url = new URL(req.url);
  const items = await listAudit(scope, {
    namespaceId: url.searchParams.get("namespaceId") ?? undefined,
    action: url.searchParams.get("action") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
    offset: url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined,
  });
  return Response.json({ items });
}
