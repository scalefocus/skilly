// Platform-admin: the Try skills switch (SKILLY_SPEC.md §61.8). Saved independently of the provider
// config (no test, no token, works with no provider configured and without AI_TOKEN_ENC_KEY).
// Unchanged ⇒ no-op; otherwise audited as settings.updated.
import { currentAccess } from "../../../../../lib/guard";
import { withSystemLog } from "../../../../../lib/apiLog";
import { setAiTryEnabled } from "../../../../../lib/settings";

export const dynamic = "force-dynamic";

export const PUT = withSystemLog("/api/admin/ai/try", async function PUT(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") return Response.json({ error: "enabled must be a boolean" }, { status: 422 });
  return Response.json(await setAiTryEnabled(body.enabled, access.userId));
});
