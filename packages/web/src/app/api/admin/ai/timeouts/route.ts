// Platform-admin: the §40.15 AI timeouts — a per-call timeout per registered feature and the §44
// draft run cap. Saved independently of the provider config (no test, no token, works with no
// provider configured and without AI_TOKEN_ENC_KEY). Audited as settings.updated. SKILLY_SPEC.md §40.9 / §40.15.
import { currentAccess } from "../../../../../lib/guard";
import { withSystemLog } from "../../../../../lib/apiLog";
import { isAiApiError, saveAiTimeouts } from "../../../../../lib/ai";

export const dynamic = "force-dynamic";

export const PUT = withSystemLog("/api/admin/ai/timeouts", async function PUT(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as unknown;
  const r = await saveAiTimeouts(body, access.userId);
  if (isAiApiError(r)) return Response.json({ error: r.error, detail: r.detail ?? null }, { status: r.status });
  return Response.json(r);
});
