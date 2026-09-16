// Real user monitoring — the chart series + per-route table (SKILLY_SPEC.md §32.8). Platform admins only.
import { currentAccess } from "../../../../../lib/guard";
import { getPlatformSettings } from "../../../../../lib/settings";
import { getRumSummary, parseRumRange } from "../../../../../lib/rum/queries";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const range = parseRumRange(new URL(req.url).searchParams.get("range"), 7);
  const [summary, settings] = await Promise.all([getRumSummary(range), getPlatformSettings()]);
  return Response.json({ ...summary, enabled: settings.rumEnabled, sampleRate: settings.rumSampleRate });
}
