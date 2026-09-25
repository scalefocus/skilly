// Feedback-survey results: the funnel, the trend and the per-question stats (SKILLY_SPEC.md §36.9 /
// §36.10). Platform admins only. Figures over fewer than 5 responses arrive withheld (null).
import { currentAccess } from "../../../../../lib/guard";
import { getSurveySummary } from "../../../../../lib/survey";
import { parseSurveyFilters } from "../../../../../lib/surveyFilters";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  return Response.json(await getSurveySummary(parseSurveyFilters(new URL(req.url).searchParams)));
}
