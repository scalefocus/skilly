// Daily-active-users trend chart data (SKILLY_SPEC.md §4). Platform admins only.
import { currentAccess } from "../../../../../lib/guard";
import { getActiveUserSeries, type DauRange } from "../../../../../lib/presence";

export const dynamic = "force-dynamic";

const RANGES: readonly DauRange[] = [7, 30, 90, "all"];

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const raw = new URL(req.url).searchParams.get("range");
  const range: DauRange = raw === "all" ? "all" : RANGES.includes(Number(raw) as DauRange) ? (Number(raw) as DauRange) : 30;

  return Response.json(await getActiveUserSeries(range));
}
