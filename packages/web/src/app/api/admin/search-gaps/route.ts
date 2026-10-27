// The Search gaps admin page's list (SKILLY_SPEC.md §62.7, §62.11). Platform admin only (403).
// GET ?tab=review|noise|accepted → { gaps, counts, status }.
import { isGapTab, listSearchGaps, getSearchGapStatus } from "../../../../lib/searchGaps";
import { currentAccess } from "../../../../lib/guard";

async function adminCaller(): Promise<{ ok: true; userId: string } | { ok: false; res: Response }> {
  const access = await currentAccess();
  if (!access) return { ok: false, res: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  if (!access.userId || !access.isPlatformAdmin) return { ok: false, res: Response.json({ error: "platform admin required" }, { status: 403 }) };
  return { ok: true, userId: access.userId };
}

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const caller = await adminCaller();
  if (!caller.ok) return caller.res;
  const tab = new URL(req.url).searchParams.get("tab") ?? "review";
  if (!isGapTab(tab)) return Response.json({ error: "tab must be review, noise or accepted" }, { status: 422 });
  const [list, status] = await Promise.all([listSearchGaps(tab), getSearchGapStatus()]);
  return Response.json({ ...list, status });
}
