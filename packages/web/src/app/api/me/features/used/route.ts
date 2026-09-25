// Record a feature's first use and maybe open a feedback-survey offer (SKILLY_SPEC.md §36.10).
// The browser calls it after a feature's defining action succeeds (§36.3). A spoofed call can only
// affect the caller's own survey, so the key is validated against the catalog and rate-limited.
import { currentAccess } from "../../../../../lib/guard";
import { enforceRateLimit } from "../../../../../lib/ratelimit";
import { recordFeatureUse } from "../../../../../lib/survey";
import { readCanShow, rollOptions } from "../../../../../lib/surveyRoute";
import { SURVEY_FEATURE_USED_RATE_PER_MIN, isSurveyFeature } from "@skilly/shared/survey";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("survey-feature-used", access.userId, SURVEY_FEATURE_USED_RATE_PER_MIN);
  if (limited) return limited;
  const body = (await req.json().catch(() => ({}))) as { feature?: unknown };
  if (!isSurveyFeature(body.feature)) return Response.json({ error: "unknown feature" }, { status: 422 });
  return Response.json(await recordFeatureUse(access.userId, body.feature, readCanShow(body), rollOptions(req)));
}
