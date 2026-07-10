// A proposal's review thread (SKILLY_SPEC.md §24, §8). GET returns the thread (lazy — null
// conversationId + empty when no one has posted yet); POST get-or-creates the conversation and
// posts. Access = submitter ∪ namespace reviewers ∪ target-skill maintainers (enforced in the lib).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../lib/access";
import { getProposalThread, postProposalMessage } from "../../../../../lib/messages";
import { enforceRateLimit } from "../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const thread = await getProposalThread(access, (await ctx.params).id);
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
  const r = await postProposalMessage(access, (await ctx.params).id, body.body ?? "");
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json({ conversationId: r.conversationId, message: r.message }, { status: 201 });
}
