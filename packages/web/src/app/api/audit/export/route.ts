// CSV export of the audit log — platform admins ONLY (namespace admins keep in-app read access
// to their own namespaces via /api/audit, but not a bulk-download button). Honors the SAME
// filters as /api/audit (action, q, from, to); capped at AUDIT_EXPORT_CAP newest-first rows —
// a truncated export still downloads, with X-Total-Matching/X-Exported-Count headers so the UI
// can warn the admin the range needs narrowing. SKILLY_SPEC.md §11.
import { currentAccess } from "../../../../lib/guard";
import { AUDIT_EXPORT_CAP, countAudit, exportAuditRows, type AuditView } from "../../../../lib/audit";
import { toCsv } from "../../../../lib/csv";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const url = new URL(req.url);
  const q = {
    action: url.searchParams.get("action") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  };
  // A platform admin's export is always the full log — no namespace narrowing.
  const scope = { all: true, namespaceIds: [] as string[] };
  const [total, rows] = await Promise.all([countAudit(scope, q), exportAuditRows(scope, q)]);

  const csv = toCsv<AuditView>(rows, [
    { header: "id", value: (r) => r.id },
    { header: "created_at", value: (r) => r.createdAt },
    { header: "action", value: (r) => r.action },
    { header: "target_type", value: (r) => r.targetType },
    { header: "target_id", value: (r) => r.targetId },
    { header: "namespace_slug", value: (r) => r.namespaceSlug },
    { header: "actor_name", value: (r) => r.actorName },
    { header: "actor_email", value: (r) => r.actorEmail },
    { header: "source", value: (r) => r.source },
    { header: "before", value: (r) => r.before },
    { header: "after", value: (r) => r.after },
  ]);

  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="skilly-audit-log_${date}.csv"`,
      "x-total-matching": String(total),
      "x-exported-count": String(rows.length),
      "x-export-cap": String(AUDIT_EXPORT_CAP),
    },
  });
}
