// Platform-admin: the §40.18 Try limits — the five limits of Try a skill (§61): messages per person
// per day and per minute, messages per conversation, characters per message and per conversation.
// Saved independently of the provider config and of the Try switch (no test, no token, works with no
// provider configured and without AI_TOKEN_ENC_KEY). Audited as settings.updated.
// SKILLY_SPEC.md §40.9 / §40.18.
import { currentAccess } from "../../../../../lib/guard";
import { withSystemLog } from "../../../../../lib/apiLog";
import { isAiApiError, saveAiTryLimits } from "../../../../../lib/ai";

export const dynamic = "force-dynamic";

export const PUT = withSystemLog("/api/admin/ai/try-limits", async function PUT(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as unknown;
  const r = await saveAiTryLimits(body, access.userId);
  if (isAiApiError(r)) return Response.json({ error: r.error, field: r.field ?? null, detail: r.detail ?? null }, { status: r.status });
  return Response.json(r);
});
