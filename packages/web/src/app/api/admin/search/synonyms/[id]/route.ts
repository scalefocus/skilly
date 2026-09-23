// Administration → Search: edit or delete one synonym group (SKILLY_SPEC.md §34.8). Platform-admin
// only; both are audited. 404 for an unknown id, 422 when the edited terms fail validation.
import { currentAccess } from "../../../../../../lib/guard";
import { updateSynonymGroup, deleteSynonymGroup, SearchAdminError } from "../../../../../../lib/searchAdmin";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function gate(ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId || !access.isPlatformAdmin) return { error: Response.json({ error: "platform admin required" }, { status: 403 }) };
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return { error: Response.json({ error: "no such synonym group" }, { status: 404 }) };
  return { userId: access.userId, id };
}

function failure(e: unknown): Response {
  if (e instanceof SearchAdminError) return Response.json({ error: e.message }, { status: e.status });
  throw e;
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate(ctx);
  if (g.error) return g.error;
  const body = (await req.json().catch(() => ({}))) as { terms?: unknown };
  try {
    return Response.json({ group: await updateSynonymGroup(g.id, body.terms, g.userId) });
  } catch (e) {
    return failure(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate(ctx);
  if (g.error) return g.error;
  try {
    await deleteSynonymGroup(g.id, g.userId);
    return Response.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
