// Platform-admin: typeahead over non-erased users for the "Delete User Info" pickers. §4
import { currentAccess } from "../../../../../lib/guard";
import { searchUsers } from "../../../../../lib/eraseUser";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 3) return Response.json({ users: [] });
  return Response.json({ users: await searchUsers(q) });
}
