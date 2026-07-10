// Proposal detail — revisions + ingest-time scan report + caller's allowed actions.
// Visibility-scoped: reviewers of the namespace or the submitter only (else 404, so the
// existence of restricted proposals never leaks). SKILLY_SPEC.md §8, §9.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { pool } from "../../../../lib/db";
import { getProposalDetail, deleteProposal } from "../../../../lib/proposals";
import { getSubmitterCard, findConversation } from "../../../../lib/messages";
import { enforceRateLimit } from "../../../../lib/ratelimit";
import { withSystemLog } from "../../../../lib/apiLog";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  const detail = await getProposalDetail(pool, (await ctx.params).id, access, access.userId);
  if (!detail) return Response.json({ error: "not found" }, { status: 404 });
  // Reviewers/maintainers get a "who submitted this" card to contact them; the submitter doesn't
  // need their own card. `conversationId` is the existing review thread (null until first message).
  const submitterCard = detail.submittedBy !== access.userId ? await getSubmitterCard(detail.submittedBy, detail.targetNamespaceId) : null;
  const conversationId = await findConversation("proposal", detail.id);
  return Response.json({ ...detail, submitterCard, conversationId });
}

// Permanently delete a proposal — reviewer housekeeping (spam/duplicates/test/mistakes), distinct
// from `reject`. Any state except `accepted`; silent + audited. Authority + cascade in
// deleteProposal. SKILLY_SPEC.md §8.
export const DELETE = withSystemLog("/api/proposals/[id]", async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("proposal-delete", access.userId, 60);
  if (limited) return limited;

  const result = await deleteProposal(pool, { proposalId: (await ctx.params).id, actorUserId: access.userId, access });
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true });
});
