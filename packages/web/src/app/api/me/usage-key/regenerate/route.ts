// Regenerate the caller's usage key (SKILLY_SPEC.md §68.4): delete + mint in one statement, so the
// old key stops working the moment the new one exists. Shown once, like the mint.
import { currentAccess } from "../../../../../lib/guard";
import { regenerateCallerUsageKey } from "../../../../../lib/usageKey";
import { getUsageInsightsEnabled } from "../../../../../lib/settings";

export const dynamic = "force-dynamic";

export async function POST() {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!(await getUsageInsightsEnabled())) return Response.json({ error: "usage insights are not enabled" }, { status: 404 });
  return Response.json({ usageKey: await regenerateCallerUsageKey(access.userId) });
}
