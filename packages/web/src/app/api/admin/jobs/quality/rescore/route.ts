// Maintenance → "Re-run quality assessment" (SKILLY_SPEC.md §41.7): marks every scored version
// stale so the worker sweep re-scans it (and, with AI on, re-judges latest versions in batches).
// Platform-admin only; audited as job.quality_rescore_requested.
import { currentAccess } from "../../../../../../lib/guard";
import { requestCatalogRescore } from "../../../../../../lib/quality";

export const dynamic = "force-dynamic";

export async function POST() {
  const access = await currentAccess();
  if (!access?.isPlatformAdmin || !access.userId) return Response.json({ error: "platform admin required" }, { status: 403 });
  const rows = await requestCatalogRescore(access.userId);
  return Response.json({ ok: true, rows }, { status: 202 });
}
