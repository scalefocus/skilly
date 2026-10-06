// Platform-admin: the §40 AI integration — status, save (runs the test first), enable/disable,
// remove. The provider token is write-only: no response ever contains it. SKILLY_SPEC.md §40.9.
import { currentAccess } from "../../../../lib/guard";
import { withSystemLog } from "../../../../lib/apiLog";
import { getAiAdminStatus, isAiApiError, removeAiIntegration, saveFromForm, setAiEnabled } from "../../../../lib/ai";

export const dynamic = "force-dynamic";

async function admin(): Promise<{ userId: string } | Response> {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  return { userId: access.userId };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const j = (await req.json().catch(() => null)) as unknown;
  return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
}

export const GET = withSystemLog("/api/admin/ai", async function GET() {
  const a = await admin();
  if (a instanceof Response) return a;
  return Response.json(await getAiAdminStatus());
});

export const PUT = withSystemLog("/api/admin/ai", async function PUT(req: Request) {
  const a = await admin();
  if (a instanceof Response) return a;
  const r = await saveFromForm(await body(req), a.userId);
  if (isAiApiError(r)) return Response.json({ error: r.error, detail: r.detail ?? null, test: r.test ?? null }, { status: r.status });
  return Response.json({ ...r, state: await getAiAdminStatus() });
});

export const PATCH = withSystemLog("/api/admin/ai", async function PATCH(req: Request) {
  const a = await admin();
  if (a instanceof Response) return a;
  const b = await body(req);
  if (typeof b.enabled !== "boolean") return Response.json({ error: "enabled must be a boolean" }, { status: 422 });
  const r = await setAiEnabled(b.enabled, a.userId);
  if (isAiApiError(r)) return Response.json({ error: r.error, detail: r.detail ?? null }, { status: r.status });
  return Response.json({ ...r, state: await getAiAdminStatus() });
});

export const DELETE = withSystemLog("/api/admin/ai", async function DELETE() {
  const a = await admin();
  if (a instanceof Response) return a;
  const r = await removeAiIntegration(a.userId);
  if (isAiApiError(r)) return Response.json({ error: r.error, detail: r.detail ?? null }, { status: r.status });
  return new Response(null, { status: 204 });
});
