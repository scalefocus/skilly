// The Feature ideas admin page's list (SKILLY_SPEC.md §60.5, §60.11). Platform admin only (403).
// GET ?status=pending|published|closed&offset= → { tab, ideas, counts, hasMore, enabled }. Readable
// while the feature is off (the page shows the lists read-only).
import { listAdminIdeas, type AdminIdeaTab } from "../../../../lib/ideas";
import { ideasAdminCaller } from "../../../../lib/ideasRoute";

export const dynamic = "force-dynamic";

const TABS: readonly AdminIdeaTab[] = ["pending", "published", "closed"];

export async function GET(req: Request) {
  const caller = await ideasAdminCaller(false);
  if (!caller.ok) return caller.res;
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "pending";
  if (!(TABS as readonly string[]).includes(status)) return Response.json({ error: "status must be pending, published or closed" }, { status: 422 });
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  return Response.json({ ...(await listAdminIdeas(status as AdminIdeaTab, offset)), enabled: caller.enabled });
}
