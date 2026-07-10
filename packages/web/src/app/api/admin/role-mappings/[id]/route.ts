// Platform-admin: remove a role mapping. SKILLY_SPEC.md §4.
import { currentAccess } from "../../../../../lib/guard";
import { pool } from "../../../../../lib/db";
import { deleteRoleMapping } from "../../../../../lib/admin";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  await deleteRoleMapping(pool, (await ctx.params).id, access.userId);
  return Response.json({ ok: true });
}
