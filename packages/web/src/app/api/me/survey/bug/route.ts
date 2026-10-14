// Report a bug (SKILLY_SPEC.md §36.17). Stored as an anonymous survey response of its own kind
// (`trigger = 'bug'`) with the page path and the server's app version. Its own rate limits (3 / min,
// 20 / day), never the survey cooldowns. Like the survey submit: no presence stamp
// (currentAccessNoStamp), no audit row, no system-log wrapper, and never sampled by RUM (§36.11).
import { currentAccessNoStamp } from "../../../../../lib/guard";
import { submitBugReport } from "../../../../../lib/survey";
import { bugReportRateLimited } from "../../../../../lib/surveyRoute";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const access = await currentAccessNoStamp();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = bugReportRateLimited(access.userId);
  if (limited) return limited;
  const body = await req.json().catch(() => ({}));
  const r = await submitBugReport({ userId: access.userId, isPlatformAdmin: access.isPlatformAdmin, namespaceRoles: access.namespaceRoles }, body);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json({ ok: true });
}
