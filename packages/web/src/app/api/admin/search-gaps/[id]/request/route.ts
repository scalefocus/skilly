// Accept a search gap as a Platform skill request (SKILLY_SPEC.md §62.6, §62.10).
// POST { title, description, usage, categories, tool, expectedUpdatedAt } → { requestId } · 404 · 409 · 422.
import { normalizeHarness, validateHarness } from "@skilly/shared/harness";
import { acceptGapAsRequest } from "../../../../../../lib/searchGaps";
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
  const b = await body(req);
  const tool = normalizeHarness(typeof b.tool === "string" && b.tool.trim() ? b.tool : "generic");
  const toolErr = validateHarness(tool);
  if (toolErr) return Response.json({ error: toolErr }, { status: 422 });
  const r = await acceptGapAsRequest(caller.userId, id, {
    title: typeof b.title === "string" ? b.title : "",
    description: typeof b.description === "string" ? b.description : "",
    usageExamples: typeof b.usage === "string" && b.usage.trim() ? b.usage : null,
    toolHarness: tool,
    categories: Array.isArray(b.categories) ? b.categories.filter((c): c is string => typeof c === "string") : [],
  }, b.expectedUpdatedAt);
  return r.ok ? Response.json({ requestId: r.requestId }) : Response.json({ error: r.error }, { status: r.status });
}
