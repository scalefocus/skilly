// Contributor leaderboard — any signed-in user. ?window=all (default) | 30d;
// ?sort=installs (default) | skills | requests | watched (§21/§26).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { getLeaderboard, type LeaderboardSort } from "../../../lib/leaderboard";
import { withSystemLog } from "../../../lib/apiLog";

export const dynamic = "force-dynamic";

export const GET = withSystemLog("/api/leaderboard", async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const url = new URL(req.url);
  const window = url.searchParams.get("window") === "30d" ? "30d" : "all";
  const sortParam = url.searchParams.get("sort");
  const sort: LeaderboardSort =
    sortParam === "skills" || sortParam === "requests" || sortParam === "watched" ? sortParam : "installs";
  const entries = await getLeaderboard(window, sort);
  // No browser caching: the heavy aggregate is already cached server-side (per window+sort), and a
  // per-URL browser cache could otherwise show one variant stale across an opt in/out toggle.
  return Response.json({ window, sort, entries });
});
