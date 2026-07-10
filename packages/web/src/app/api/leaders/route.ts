// Leader badges (§21 extension): { [userId]: [{ metric, window }] } for every current leader,
// across all 4 metrics and both windows. Any signed-in user — same audience as the leaderboard
// itself, and carries no more information than it already exposes publicly.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { getLeaderBadges } from "../../../lib/leaders";
import { withSystemLog } from "../../../lib/apiLog";

export const dynamic = "force-dynamic";

export const GET = withSystemLog("/api/leaders", async function GET() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  return Response.json(await getLeaderBadges());
});
