// Platform-admin: the namespace-delete preflight the dialog opens with (SKILLY_SPEC.md §72.5, §72.9) —
// the blockers (live skills, open proposals) or, when there are none, what the delete will do.
import { currentAccess } from "../../../../../../lib/guard";
import { pool } from "../../../../../../lib/db";
import { namespaceDeletionPreflight } from "../../../../../../lib/namespaceDelete";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const result = await namespaceDeletionPreflight(pool, (await ctx.params).id, access.userId);
  if (!result.ok) {
    const { status, ...rest } = result;
    return Response.json(rest, { status });
  }
  return Response.json(result.preflight);
}
