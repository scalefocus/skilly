// Platform-admin: erase a user's info (GDPR), optionally transferring their maintainerships. §4
import { currentAccess } from "../../../../../../lib/guard";
import { eraseUser } from "../../../../../../lib/eraseUser";
import { withSystemLog } from "../../../../../../lib/apiLog";

export const dynamic = "force-dynamic";

export const POST = withSystemLog("/api/admin/users/[id]/erase", async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { transferTo?: string | null };
  const r = await eraseUser(access.userId, id, body.transferTo?.trim() || null);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json({ ok: true, transferred: r.transferred, skipped: r.skipped });
});
