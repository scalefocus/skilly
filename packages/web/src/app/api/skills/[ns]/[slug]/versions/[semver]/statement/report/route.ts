// Report a signature mismatch to the platform admins (SKILLY_SPEC.md §73.11): paths, statuses and
// hashes only — never file contents. Visibility first (404); 10 reports per hour per user (429).
import { currentAccess } from "../../../../../../../../../lib/guard";
import { withSystemLog } from "../../../../../../../../../lib/apiLog";
import { canonicalSkillParams } from "../../../../../../../../../lib/skillMoves";
import {
  REPORTS_PER_HOUR,
  parseMismatchReport,
  recentReportCount,
  recordMismatchReport,
  statementPayload,
  visibleSkillForVersion,
} from "../../../../../../../../../lib/signing";

export const dynamic = "force-dynamic";

export const POST = withSystemLog(
  "/api/skills/[ns]/[slug]/versions/[semver]/statement/report",
  async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string; semver: string }> }) {
    const access = await currentAccess();
    if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
    if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

    const { ns, slug, semver } = await canonicalSkillParams(ctx.params);
    const skill = await visibleSkillForVersion(access, ns, slug, semver);
    if (!skill) return Response.json({ error: "not found" }, { status: 404 });
    if (!(await statementPayload(skill.id, semver))) return Response.json({ error: "not found" }, { status: 404 });

    const report = parseMismatchReport(await req.json().catch(() => null));
    if (typeof report === "string") return Response.json({ error: report }, { status: 422 });
    if ((await recentReportCount(access.userId)) >= REPORTS_PER_HOUR) {
      return Response.json({ error: `at most ${REPORTS_PER_HOUR} reports per hour` }, { status: 429, headers: { "Retry-After": "3600" } });
    }
    await recordMismatchReport(access, skill, semver, report);
    return Response.json({ ok: true });
  },
);
