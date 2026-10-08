// Platform-admin: the AI pre-review switch (SKILLY_SPEC.md §46.2, §46.11). Saved independently of
// the provider config (no test, no token, works with no provider configured and without
// AI_TOKEN_ENC_KEY). Unchanged ⇒ no-op; otherwise audited as settings.updated.
import { currentAccess } from "../../../../../lib/guard";
import { withSystemLog } from "../../../../../lib/apiLog";
import { setPrereviewEnabled } from "../../../../../lib/aiPrereview";

export const dynamic = "force-dynamic";

export const PUT = withSystemLog("/api/admin/ai/prereview", async function PUT(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") return Response.json({ error: "enabled must be a boolean" }, { status: 422 });
  return Response.json(await setPrereviewEnabled(body.enabled, access.userId));
});
