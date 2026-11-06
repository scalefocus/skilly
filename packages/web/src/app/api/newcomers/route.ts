// New users (SKILLY_SPEC.md §67.3): { ids: [userId] } — the page-wide map behind the propeller-beanie
// hat every avatar bubble draws. Any signed-in user, like /api/levels: it discloses only that a
// person is in their first 30 days, the same fact their card's New user row states, and omits
// anyone who opted out. Empty while the visits_enabled switch is off.
import { withSystemLog } from "../../../lib/apiLog";
import { currentAccess } from "../../../lib/guard";
import { getNewcomers } from "../../../lib/newcomers";
import { getVisitsEnabled } from "../../../lib/settings";

export const dynamic = "force-dynamic";

export const GET = withSystemLog("/api/newcomers", async function GET() {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  return Response.json(await getNewcomers(await getVisitsEnabled()));
});
