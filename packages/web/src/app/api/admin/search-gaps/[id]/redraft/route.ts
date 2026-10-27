// Redraft a search gap (SKILLY_SPEC.md §62.6): clears the draft so the next run drafts it again.
// POST { expectedUpdatedAt } → 204 · 404 · 409 (changed, or AI not operational). Not audited.
import { redraftGap } from "../../../../../../lib/searchGaps";
import { currentAccess } from "../../../../../../lib/guard";

async function adminCaller(): Promise<{ ok: true; userId: string } | { ok: false; res: Response }> {
  const access = await currentAccess();
  if (!access) return { ok: false, res: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  if (!access.userId || !access.isPlatformAdmin) return { ok: false, res: Response.json({ error: "platform admin required" }, { status: 403 }) };
  return { ok: true, userId: access.userId };
}

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function body(req: Request): Promise<Record<string, unknown>> {
  const b: unknown = await req.json().catch(() => ({}));
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await adminCaller();
  if (!caller.ok) return caller.res;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const r = await redraftGap(id, (await body(req)).expectedUpdatedAt);
  return r.ok ? new Response(null, { status: 204 }) : Response.json({ error: r.error }, { status: r.status });
}
