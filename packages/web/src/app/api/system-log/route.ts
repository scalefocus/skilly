// System log read API (SKILLY_SPEC.md §25) — platform admins ONLY. Unlike /api/audit (which
// also serves namespace admins), this is hard-gated to platform admins: a namespace admin
// calling it directly gets 403, not just a hidden nav link.
import { currentAccess } from "../../../lib/guard";
import { listSystemEvents } from "../../../lib/systemLog";

export async function GET(req: Request): Promise<Response> {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const url = new URL(req.url);
  const items = await listSystemEvents({
    q: url.searchParams.get("q") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 100),
    offset: Number(url.searchParams.get("offset") ?? 0),
  });
  return Response.json({ items });
}
