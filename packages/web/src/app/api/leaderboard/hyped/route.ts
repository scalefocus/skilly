// The Hyped-skills board (SKILLY_SPEC.md §50.5 / §50.10) — any signed-in user. Up to
// LEADERBOARD_LIMIT hard-eligible skills by the §50.4 score over the trailing 7 days, plus the
// viewer's own budget and per-row flags. Every listed skill is org-visible by construction (§50.1
// decision 2), so the board is the same for everyone apart from the two per-viewer flags.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { getHypeBoardForViewer } from "../../../../lib/hype";
import { withSystemLog } from "../../../../lib/apiLog";

export const dynamic = "force-dynamic";

export const GET = withSystemLog("/api/leaderboard/hyped", async function GET() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  const { rows, budget, settings } = await getHypeBoardForViewer(access.userId);
  if (!settings.enabled) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ entries: rows, budget, topN: settings.topN });
});
