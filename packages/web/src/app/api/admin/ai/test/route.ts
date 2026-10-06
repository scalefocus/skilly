// Platform-admin: §40.5 connectivity test of the form values (saved or not). Always 200 with
// ok:false on a provider failure; 422 only for invalid input / ai_token_required. Unaudited.
import { currentAccess } from "../../../../../lib/guard";
import { withSystemLog } from "../../../../../lib/apiLog";
import { isAiApiError, testFromForm } from "../../../../../lib/ai";

export const dynamic = "force-dynamic";

export const POST = withSystemLog("/api/admin/ai/test", async function POST(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const j = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = await testFromForm(j && typeof j === "object" ? j : {}, access.userId);
  if (isAiApiError(r)) return Response.json({ error: r.error, detail: r.detail ?? null }, { status: r.status });
  return Response.json(r);
});
