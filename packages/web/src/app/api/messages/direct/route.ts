// Start (or reuse) a 1:1 direct conversation with another user — e.g. "Reach out" to a maintainer.
// SKILLY_SPEC.md §24. Returns the conversation id; the client opens it in the messages menu.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { getOrCreateDirectConversation } from "../../../../lib/messages";
import { enforceRateLimit } from "../../../../lib/ratelimit";
import { withSystemLog } from "../../../../lib/apiLog";

export const dynamic = "force-dynamic";

export const POST = withSystemLog("/api/messages/direct", async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("messages", access.userId, 60);
  if (limited) return limited;
  const body = (await req.json().catch(() => ({}))) as { userId?: string };
  if (!body.userId) return Response.json({ error: "userId required" }, { status: 422 });
  const r = await getOrCreateDirectConversation(access, body.userId);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json({ conversationId: r.conversationId });
});
