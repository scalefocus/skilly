// A single conversation: GET the thread, POST a message (SKILLY_SPEC.md §24). Access is enforced
// in the lib against the conversation's context (a non-member 404s — no leak).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { getThread, postToConversation } from "../../../../lib/messages";
import { enforceRateLimit } from "../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const thread = await getThread(access, (await ctx.params).id);
  if (!thread) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(thread);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("messages", access.userId, 60);
  if (limited) return limited;
  const body = (await req.json().catch(() => ({}))) as { body?: string };
  const r = await postToConversation(access, (await ctx.params).id, body.body ?? "");
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json({ message: r.message }, { status: 201 });
}
