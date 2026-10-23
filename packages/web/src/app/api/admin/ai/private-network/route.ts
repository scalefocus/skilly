// Platform-admin: the §40.16 private-network switch. Saved independently of the provider config
// (works with no provider configured and without AI_TOKEN_ENC_KEY), then the saved config is
// re-tested under the new setting so the status pill follows. Unchanged ⇒ no-op; otherwise audited
// as settings.updated. SKILLY_SPEC.md §40.9 / §40.16.
import { currentAccess } from "../../../../../lib/guard";
import { withSystemLog } from "../../../../../lib/apiLog";
import { setAiAllowPrivateNetwork } from "../../../../../lib/ai";

export const dynamic = "force-dynamic";

export const PUT = withSystemLog("/api/admin/ai/private-network", async function PUT(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") return Response.json({ error: "enabled must be a boolean" }, { status: 422 });
  return Response.json(await setAiAllowPrivateNetwork(body.enabled, access.userId));
});
