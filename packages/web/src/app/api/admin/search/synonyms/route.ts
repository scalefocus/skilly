// Administration → Search: the synonym groups (SKILLY_SPEC.md §34.8). Platform-admin only.
//   GET  → { groups } in creation order, each flagged with the groups it collides with
//   POST → { terms: string[] | "comma, separated" } creates a group (422 on any validation failure)
import { currentAccess } from "../../../../../lib/guard";
import { listSynonymGroups, createSynonymGroup, SearchAdminError } from "../../../../../lib/searchAdmin";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access?.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  return Response.json({ groups: await listSynonymGroups() });
}

export async function POST(req: Request) {
  const access = await currentAccess();
  if (!access?.userId || !access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { terms?: unknown };
  try {
    return Response.json({ group: await createSynonymGroup(body.terms, access.userId) }, { status: 201 });
  } catch (e) {
    if (e instanceof SearchAdminError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
