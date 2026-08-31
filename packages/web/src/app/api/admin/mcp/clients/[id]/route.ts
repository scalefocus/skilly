// §29: block / unblock one registered MCP client, platform-wide. Blocking refuses its token
// exchanges and every MCP request under it WITHOUT revoking anyone's grant, so unblocking restores
// service without re-onboarding the org. This is the per-client incident control; there is
// deliberately no org-wide "revoke all" (a footgun whose only outcome is mass re-authorization).
import { currentAccess } from "../../../../../../lib/guard";
import { setClientBlocked } from "../../../../../../lib/mcpOauth";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId || !access.isPlatformAdmin) {
    return Response.json({ error: "platform admin required" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { blocked?: unknown };
  if (typeof body.blocked !== "boolean") {
    return Response.json({ error: "blocked must be true or false" }, { status: 422 });
  }
  const done = await setClientBlocked(id, body.blocked, access.userId);
  return done ? Response.json({ ok: true, blocked: body.blocked }) : Response.json({ error: "no such client" }, { status: 404 });
}
