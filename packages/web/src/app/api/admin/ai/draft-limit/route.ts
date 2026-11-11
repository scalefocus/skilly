// Platform-admin: the §40.17 daily draft limit — how many times a day one person may use Draft with
// AI (§43), on the propose form and in the repository import together. Saved independently of the
// provider config (no test, no token, works with no provider configured and without
// AI_TOKEN_ENC_KEY). Audited as settings.updated. SKILLY_SPEC.md §40.9 / §40.17.
import { currentAccess } from "../../../../../lib/guard";
import { withSystemLog } from "../../../../../lib/apiLog";
import { isAiApiError, saveAiDraftLimit } from "../../../../../lib/ai";

export const dynamic = "force-dynamic";

export const PUT = withSystemLog("/api/admin/ai/draft-limit", async function PUT(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as unknown;
  const r = await saveAiDraftLimit(body, access.userId);
  if (isAiApiError(r)) return Response.json({ error: r.error, detail: r.detail ?? null }, { status: r.status });
  return Response.json(r);
});
