// Real user monitoring — who was affected on a route (SKILLY_SPEC.md §32.8). Platform admins only.
// Raw-window only (7d / 30d): the daily rollup has no user dimension, so 90d / All answer 422.
import { currentAccess } from "../../../../../../../lib/guard";
import { getRumRouteUsers } from "../../../../../../../lib/rum/queries";
import { isKnownPageRoute, RUM_ROUTE_ALL } from "../../../../../../../lib/rum/routes";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ route: string }> }) {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const { route: rawRoute } = await ctx.params;
  let route: string;
  try {
    route = decodeURIComponent(rawRoute);
  } catch {
    return Response.json({ error: "bad route" }, { status: 400 });
  }
  if (route !== RUM_ROUTE_ALL && !isKnownPageRoute(route)) return Response.json({ error: "unknown route" }, { status: 404 });

  const rangeRaw = new URL(req.url).searchParams.get("range");
  const range = rangeRaw === "30" ? 30 : rangeRaw === "7" || rangeRaw == null ? 7 : null;
  if (range === null) return Response.json({ error: "the per-user drill-down is available for the 7d and 30d ranges only" }, { status: 422 });

  return Response.json({ users: await getRumRouteUsers(route, range) });
}
