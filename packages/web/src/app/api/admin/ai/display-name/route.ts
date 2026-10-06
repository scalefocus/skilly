// Platform-admin: the §40.14 AI display name — the word end users see in place of "AI". Saved
// independently of the provider config (no test, no token, works with no provider configured and
// without AI_TOKEN_ENC_KEY). Audited as settings.updated. SKILLY_SPEC.md §40.9 / §40.14.
import { currentAccess } from "../../../../../lib/guard";
import { withSystemLog } from "../../../../../lib/apiLog";
import { setAiDisplayName } from "../../../../../lib/settings";

export const dynamic = "force-dynamic";

export const PUT = withSystemLog("/api/admin/ai/display-name", async function PUT(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { displayName?: unknown } | null;
  if (!body || typeof body !== "object" || !("displayName" in body)) {
    return Response.json({ error: "displayName is required (an empty string restores the default)" }, { status: 422 });
  }
  const r = await setAiDisplayName(body.displayName, access.userId);
  if (!r.ok) return Response.json({ error: r.error }, { status: 422 });
  return Response.json({ displayName: r.displayName });
});
