// The long-time-user fallback roll (SKILLY_SPEC.md §36.1 / §36.10): AppShell calls it once per full
// page load, when it could show a survey and no offer is open.
import { currentAccess } from "../../../../../lib/guard";
import { enforceRateLimit } from "../../../../../lib/ratelimit";
import { checkVisitSurvey } from "../../../../../lib/survey";
import { readCanShow, rollOptions } from "../../../../../lib/surveyRoute";
import { SURVEY_CHECK_RATE_PER_MIN } from "@skilly/shared/survey";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("survey-check", access.userId, SURVEY_CHECK_RATE_PER_MIN);
  if (limited) return limited;
  const body = await req.json().catch(() => ({}));
  return Response.json({ survey: await checkVisitSurvey(access.userId, readCanShow(body), rollOptions(req)) });
}
