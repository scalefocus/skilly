// Feedback-survey free-text feed, 50 at a time (SKILLY_SPEC.md §36.9 / §36.10). Platform admins
// only. Withheld as a whole when the filtered response set is under 5.
import { currentAccess } from "../../../../../lib/guard";
import { getSurveyComments } from "../../../../../lib/survey";
import { parseSurveyFilters } from "../../../../../lib/surveyFilters";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const offset = Math.max(0, Number.parseInt(sp.get("offset") ?? "0", 10) || 0);
  const limit = Math.min(50, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));
  return Response.json(await getSurveyComments(parseSurveyFilters(sp), offset, limit));
}
