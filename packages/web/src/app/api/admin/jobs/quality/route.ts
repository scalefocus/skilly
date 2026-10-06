// Maintenance → quality assessment progress (SKILLY_SPEC.md §41.7, §41.11). Platform-admin only;
// the Maintenance card polls it.
import { currentAccess } from "../../../../../lib/guard";
import { qualityProgress } from "../../../../../lib/quality";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access?.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  return Response.json(await qualityProgress());
}
