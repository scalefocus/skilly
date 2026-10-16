// Trim audit events older than one year. Platform admins only. SKILLY_SPEC.md §11, §49.6.
// The delete runs inside the SECURITY DEFINER `trim_audit_log()` (migration 0096) — the one
// audited, chain-rebaselining path; the app role holds no UPDATE/DELETE on audit_log.
import { currentAccess } from "../../../../lib/guard";
import { trimAuditLog, AUDIT_TRIM_FLOOR } from "../../../../lib/audit";

export const dynamic = "force-dynamic";

export async function POST() {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  try {
    const { deleted } = await trimAuditLog(access.userId, "1 year");
    return Response.json({ ok: true, deleted });
  } catch (e) {
    // The DB enforces the one-year floor (§49.6); the UI offers no shorter choice.
    if (e instanceof Error && e.message === AUDIT_TRIM_FLOOR) {
      return Response.json({ error: AUDIT_TRIM_FLOOR }, { status: 422 });
    }
    throw e;
  }
}
