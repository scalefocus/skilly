// "Propose an existing skill" (§26): immediate, no-review fulfilment of an open request by
// linking it to a skill that already exists. Any authenticated user may call this — same
// implicit right as posting a proposal. Server-side re-validates the skill is active + org-visible
// regardless of what the client's search dropdown showed.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../lib/access";
import { fulfilWithExistingSkill } from "../../../../../lib/requests";
import { withSystemLog } from "../../../../../lib/apiLog";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = withSystemLog("/api/requests/[id]/fulfil", async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return Response.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { namespaceSlug?: string; skillSlug?: string } | null;
  if (!body?.namespaceSlug || !body?.skillSlug) return Response.json({ error: "namespaceSlug and skillSlug are required" }, { status: 422 });

  const result = await fulfilWithExistingSkill(access.userId, id, body.namespaceSlug, body.skillSlug);
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true });
});
