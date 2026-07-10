// Platform-admin: update a namespace (review policy / maintainer). SKILLY_SPEC.md §4.
import { currentAccess } from "../../../../../lib/guard";
import { pool } from "../../../../../lib/db";
import { updateNamespace } from "../../../../../lib/admin";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const body = (await req.json()) as { requireReview?: boolean; maintainerContact?: string | null };
  const err = await updateNamespace(pool, (await ctx.params).id, body, access.userId);
  if (err) return Response.json(err, { status: 422 });
  return Response.json({ ok: true });
}
