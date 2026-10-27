// One skill request (§26): read, requester edit (JSON, text-only), requester withdraw (own
// request only) / platform-admin remove (moderation, any request) — both permanently delete it.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { getRequest, updateRequest, closeRequest } from "../../../../lib/requests";
import { withSystemLog } from "../../../../lib/apiLog";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function gate() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return { error: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  const access = await resolveUserAccess(oid);
  if (!access.userId) return { error: Response.json({ error: "unknown user" }, { status: 403 }) };
  return { access, userId: access.userId };
}

export const GET = withSystemLog("/api/requests/[id]", async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate();
  if (g.error) return g.error;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const request = await getRequest(id);
  // Withdrawn/removed/fulfilled requests stay readable (the fulfilment notification links here
  // indirectly via the skill; direct opens of a closed request show its state).
  if (!request) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({
    request,
    isRequester: request.requesterUserId !== null && request.requesterUserId === g.userId,
    isPlatformAdmin: g.access.isPlatformAdmin,
    // §62.10: the requester edits their own open request; platform admins edit a Platform request.
    canEdit: request.state === "open" && (request.requesterUserId === null ? g.access.isPlatformAdmin : request.requesterUserId === g.userId),
  });
});

export const PATCH = withSystemLog("/api/requests/[id]", async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate();
  if (g.error) return g.error;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as {
    title?: string; description?: string; usageExamples?: string | null; toolHarness?: string; categories?: string[];
  } | null;
  if (!body) return Response.json({ error: "invalid body" }, { status: 422 });
  const result = await updateRequest(g.userId, id, {
    title: body.title ?? "",
    description: body.description ?? "",
    usageExamples: body.usageExamples ?? null,
    toolHarness: body.toolHarness ?? "generic",
    categories: Array.isArray(body.categories) ? body.categories : [],
  }, g.access.isPlatformAdmin); // platform admins edit Platform requests (§62.10)
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true });
});

export const DELETE = withSystemLog("/api/requests/[id]", async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate();
  if (g.error) return g.error;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const result = await closeRequest(g.userId, g.access.isPlatformAdmin, id);
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true });
});
