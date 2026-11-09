// The caller's usage key (SKILLY_SPEC.md §68.4/§68.8): mint (POST) and stop sharing (DELETE).
// Regenerate lives at ./regenerate. Session-authenticated; the raw key is in the mint response
// and nowhere else.
import { currentAccess } from "../../../../lib/guard";
import { deleteCallerUsageKey, mintCallerUsageKey } from "../../../../lib/usageKey";
import { getUsageInsightsEnabled } from "../../../../lib/settings";

export const dynamic = "force-dynamic";

export async function POST() {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  // Minting is pointless while the feature is off — no plugin carries the hook (§68.4).
  if (!(await getUsageInsightsEnabled())) return Response.json({ error: "usage insights are not enabled" }, { status: 404 });
  const minted = await mintCallerUsageKey(access.userId);
  if (!minted) return Response.json({ error: "usage_key_exists" }, { status: 409 });
  return Response.json({ usageKey: minted });
}

export async function DELETE() {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const deleted = await deleteCallerUsageKey(access.userId);
  return Response.json({ ok: true, deleted });
}
