// Maintenance → content check progress (SKILLY_SPEC.md §37.8): active versions checked at the
// current ruleset out of all active versions. Platform-admin only; the Maintenance card polls it.
import { currentAccess } from "../../../../../lib/guard";
import { contentRiskProgress } from "../../../../../lib/contentRisk";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access?.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  return Response.json(await contentRiskProgress());
}
