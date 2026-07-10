// Messaging list + unread summary for the topbar messages menu (SKILLY_SPEC.md §24).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { resolveUserAccess } from "../../../lib/access";
import { listConversations } from "../../../lib/messages";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const offset = Number(new URL(req.url).searchParams.get("offset") ?? 0);
  return Response.json(await listConversations(access, { offset }));
}
