// Trim audit events older than one year. Platform admins only. SKILLY_SPEC.md §11.
// Relaxes the append-only invariant for this one explicit, audited, chain-rebaselining op.
import { currentAccess } from "../../../../lib/guard";
import { trimAuditLog } from "../../../../lib/audit";

export const dynamic = "force-dynamic";

export async function POST() {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const { deleted } = await trimAuditLog(access.userId, "1 year");
  return Response.json({ ok: true, deleted });
}
