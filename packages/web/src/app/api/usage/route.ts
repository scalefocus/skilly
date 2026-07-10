// Usage dashboard (SKILLY_SPEC.md §21). Returns the skills the caller governs/owns with
// view/install windows + deltas, plus the aggregate they're entitled to. Entitlement resolved
// server-side; a caller with no owned skills gets an empty list.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { resolveUserAccess } from "../../../lib/access";
import { getUsageDashboard, SERIES_DAYS_CHOICES, type SeriesRangeOpt } from "../../../lib/usage";
import { enforceRateLimit } from "../../../lib/ratelimit";
import { withSystemLog } from "../../../lib/apiLog";

export const dynamic = "force-dynamic";

export const GET = withSystemLog("/api/usage", async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("usage", access.userId, 60);
  if (limited) return limited;

  // Charted range (§21 "Graphs"): 7/30/90 daily buckets, or "all" (adaptive buckets); else 30.
  const url = new URL(req.url);
  const daysParam = url.searchParams.get("days");
  const raw = Number(daysParam);
  const range: SeriesRangeOpt = daysParam === "all"
    ? "all"
    : (SERIES_DAYS_CHOICES as readonly number[]).includes(raw)
      ? (raw as SeriesRangeOpt)
      : 30;
  const q = url.searchParams.get("q")?.slice(0, 120) ?? undefined;

  return Response.json(await getUsageDashboard(access, access.userId, range, q));
});
