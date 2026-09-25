// Close the feedback-survey card — "not now" (SKILLY_SPEC.md §36.1 / §36.10). The offer stays open
// behind the account-menu entry; only its first close bumps the funnel. 409 when nothing is open.
import { currentAccess } from "../../../../../lib/guard";
import { closeSurvey } from "../../../../../lib/survey";

export const dynamic = "force-dynamic";

export async function POST() {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  if (!(await closeSurvey(access.userId))) return Response.json({ error: "no_open_survey" }, { status: 409 });
  return Response.json({ ok: true });
}
