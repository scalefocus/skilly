// Run now (SKILLY_SPEC.md §62.8): the worker's sweep picks the marker up within a minute.
// POST → 204 · 409 while collection is off. Platform admin only; audited.
import { requestSearchGapRun } from "../../../../../lib/searchGaps";
import { currentAccess } from "../../../../../lib/guard";

async function adminCaller(): Promise<{ ok: true; userId: string } | { ok: false; res: Response }> {
  const access = await currentAccess();
  if (!access) return { ok: false, res: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  if (!access.userId || !access.isPlatformAdmin) return { ok: false, res: Response.json({ error: "platform admin required" }, { status: 403 }) };
  return { ok: true, userId: access.userId };
}

export const dynamic = "force-dynamic";

export async function POST() {
  const caller = await adminCaller();
  if (!caller.ok) return caller.res;
  const r = await requestSearchGapRun(caller.userId);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return new Response(null, { status: 204 });
}
