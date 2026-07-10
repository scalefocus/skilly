// The signed-in user's installed skills (SKILLY_SPEC.md §23). Owner-scoped; lists USED installs.
// ?scope=system lists ALL system installations platform-wide — platform admins only (§23
// "System installations").
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { resolveUserAccess } from "../../../lib/access";
import { listInstalls, listSystemInstalls } from "../../../lib/installs";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);

  const scope = new URL(req.url).searchParams.get("scope");
  if (scope === "system") {
    if (!access.isPlatformAdmin) return Response.json({ error: "forbidden" }, { status: 403 });
    return Response.json({ installs: await listSystemInstalls() });
  }

  if (!access.userId) return Response.json({ installs: [] });
  return Response.json({ installs: await listInstalls(access.userId) });
}
