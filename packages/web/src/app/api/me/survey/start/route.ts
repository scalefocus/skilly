// "Give feedback now" — start an on-demand feedback survey (SKILLY_SPEC.md §36.16 / §36.10). An
// open offer (random or on-demand) is returned unchanged; otherwise a `self` offer is opened and
// its 7-day cooldown stamped. 409 `surveys_off` while the platform switch is off, 409 `cooldown`
// `{ nextAt }` while the cooldown runs. Carries no answers, so it is sampled by RUM normally.
import { currentAccess } from "../../../../../lib/guard";
import { enforceRateLimit } from "../../../../../lib/ratelimit";
import { startSelfSurvey } from "../../../../../lib/survey";
import { SURVEY_START_RATE_PER_MIN } from "@skilly/shared/survey";

export const dynamic = "force-dynamic";

export async function POST() {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("survey-start", access.userId, SURVEY_START_RATE_PER_MIN);
  if (limited) return limited;
  const r = await startSelfSurvey(access.userId);
  if (!r.ok) {
    if (r.error === "inactive") return Response.json({ error: "unknown user" }, { status: 403 });
    return Response.json({ error: r.error, ...(r.nextAt ? { nextAt: r.nextAt } : {}) }, { status: 409 });
  }
  return Response.json({ survey: r.survey, created: r.created });
}
