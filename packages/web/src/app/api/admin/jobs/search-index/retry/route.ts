// Maintenance → "Retry failed" (SKILLY_SPEC.md §34.10): re-arm every failed SKILL.md extraction.
// The worker's sweep picks them up on its next pass — no signal needed. Platform-admin only;
// audited as job.search_retry_requested with the number of rows reset.
import { currentAccess } from "../../../../../../lib/guard";
import { retryFailedSearchIndex, getSearchIndexStatus } from "../../../../../../lib/searchAdmin";

export const dynamic = "force-dynamic";

export async function POST() {
  const access = await currentAccess();
  if (!access?.userId || !access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const reset = await retryFailedSearchIndex(access.userId);
  return Response.json({ reset, status: await getSearchIndexStatus() });
}
