// Maintenance → search index status (SKILLY_SPEC.md §34.10): how many active versions have their
// SKILL.md text indexed / pending / failed, and the progress of a search-language rebuild.
// Platform-admin only; the Maintenance card polls it.
import { currentAccess } from "../../../../../lib/guard";
import { getSearchIndexStatus } from "../../../../../lib/searchAdmin";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access?.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  return Response.json(await getSearchIndexStatus());
}
