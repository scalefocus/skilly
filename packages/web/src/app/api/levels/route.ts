// Achievement levels (§31.10): { levels: { [userId]: number }, heroes: [userId] } — the bulk map
// behind the ring every avatar bubble draws. Any signed-in user, exactly like /api/leaders: it
// discloses one number per person, the same number the hover card already shows, and omits anyone
// who opted out. Empty while the platform toggle is off.
import { withSystemLog } from "../../../lib/apiLog";
import { currentAccess } from "../../../lib/guard";
import { getLevelMapFor } from "../../../lib/levels";
import { getAchievementsEnabled } from "../../../lib/settings";

export const dynamic = "force-dynamic";

export const GET = withSystemLog("/api/levels", async function GET() {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  return Response.json(await getLevelMapFor(access.userId, await getAchievementsEnabled()));
});
