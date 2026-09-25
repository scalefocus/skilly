// Submit the open feedback survey (SKILLY_SPEC.md §36.6 / §36.10). The response is stored with NO
// user reference and only today's UTC date. Deliberately: no presence stamp (currentAccessNoStamp),
// no audit row, no system-log wrapper, and the RUM collector never samples this path (§36.11) —
// each would tie a person to the moment of submission.
import { currentAccessNoStamp } from "../../../../../lib/guard";
import { enforceRateLimit } from "../../../../../lib/ratelimit";
import { submitSurvey } from "../../../../../lib/survey";
import { SURVEY_SUBMIT_RATE_PER_MIN } from "@skilly/shared/survey";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const access = await currentAccessNoStamp();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("survey-submit", access.userId, SURVEY_SUBMIT_RATE_PER_MIN);
  if (limited) return limited;
  const body = await req.json().catch(() => ({}));
  const r = await submitSurvey({ userId: access.userId, isPlatformAdmin: access.isPlatformAdmin, namespaceRoles: access.namespaceRoles }, body);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json({ ok: true });
}
