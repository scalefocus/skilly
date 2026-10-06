// Platform-admin: the provider's model list for the §40 card's dropdown. The stored token is
// only used when provider + base URL match the saved config (§40.1 #7). SKILLY_SPEC.md §40.9.
import { currentAccess } from "../../../../../lib/guard";
import { withSystemLog } from "../../../../../lib/apiLog";
import { isAiApiError, listModelsForForm } from "../../../../../lib/ai";

export const dynamic = "force-dynamic";

export const POST = withSystemLog("/api/admin/ai/models", async function POST(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const j = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await listModelsForForm(j && typeof j === "object" ? j : {});
  if (isAiApiError(r)) return Response.json({ error: r.error, detail: r.detail ?? null }, { status: r.status });
  return Response.json(r);
});
