// Real user monitoring — the fingerprinted client errors (SKILLY_SPEC.md §32.8). Platform admins only.
import { currentAccess } from "../../../../../lib/guard";
import { listRumErrors, parseRumRange } from "../../../../../lib/rum/queries";

export const dynamic = "force-dynamic";

const PAGE = 50;

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const url = new URL(req.url);
  const range = parseRumRange(url.searchParams.get("range"), 7);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const limit = Math.min(PAGE, Math.max(1, Number(url.searchParams.get("limit") ?? PAGE) || PAGE));
  const { errors, total } = await listRumErrors(range, offset, limit);
  return Response.json({ errors, total, hasMore: offset + errors.length < total });
}
