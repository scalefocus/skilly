// CSV export of the system log — platform admins ONLY (the whole surface already hard-gates
// everyone else). Honors the SAME filters as /api/system-log (status, q, from, to); capped at
// SYSTEM_EVENT_EXPORT_CAP newest-first rows — a truncated export still downloads, with
// X-Total-Matching/X-Exported-Count headers so the UI can warn the admin the range needs
// narrowing. SKILLY_SPEC.md §25.
import { currentAccess } from "../../../../lib/guard";
import { SYSTEM_EVENT_EXPORT_CAP, countSystemEvents, exportSystemEventRows, type SystemEventView } from "../../../../lib/systemLog";
import { toCsv } from "../../../../lib/csv";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const url = new URL(req.url);
  const q = {
    status: url.searchParams.get("status") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  };
  const [total, rows] = await Promise.all([countSystemEvents(q), exportSystemEventRows(q)]);

  const csv = toCsv<SystemEventView>(rows, [
    { header: "id", value: (r) => r.id },
    { header: "created_at", value: (r) => r.createdAt },
    { header: "status", value: (r) => r.status },
    { header: "method", value: (r) => r.method },
    { header: "route", value: (r) => r.route },
    { header: "path", value: (r) => r.path },
    { header: "user_id", value: (r) => r.userId },
    { header: "actor_name", value: (r) => r.actorName },
    { header: "actor_email", value: (r) => r.actorEmail },
    { header: "error_code", value: (r) => r.errorCode },
    { header: "message", value: (r) => r.message },
    { header: "request_id", value: (r) => r.requestId },
    { header: "duration_ms", value: (r) => r.durationMs },
    { header: "source", value: (r) => r.source },
  ]);

  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="skilly-system-log_${date}.csv"`,
      "x-total-matching": String(total),
      "x-exported-count": String(rows.length),
      "x-export-cap": String(SYSTEM_EVENT_EXPORT_CAP),
    },
  });
}
