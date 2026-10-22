// The Feature ideas admin page's list (SKILLY_SPEC.md §60.5, §60.11). Platform admin only (403).
// GET ?status=pending|published|closed&offset= → { tab, ideas, counts, hasMore, enabled }. `enabled`
// is the switch: off, only platform admins may suggest, and the page says so.
import { listAdminIdeas, type AdminIdeaTab } from "../../../../lib/ideas";
import { ideasAdminCaller } from "../../../../lib/ideasRoute";
import { getFeatureIdeasEnabled } from "../../../../lib/settings";

export const dynamic = "force-dynamic";

const TABS: readonly AdminIdeaTab[] = ["pending", "published", "closed"];

export async function GET(req: Request) {
  const caller = await ideasAdminCaller();
  if (!caller.ok) return caller.res;
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "pending";
  if (!(TABS as readonly string[]).includes(status)) return Response.json({ error: "status must be pending, published or closed" }, { status: 422 });
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  const [list, enabled] = await Promise.all([listAdminIdeas(status as AdminIdeaTab, offset), getFeatureIdeasEnabled()]);
  return Response.json({ ...list, enabled });
}
