// Moderator delete of a single skill-discussion comment (SKILLY_SPEC.md §24). The ONLY message
// delete in the system: effective maintainers (explicit ∪ namespace admins) ∪ platform admins may
// hard-delete any comment on their skill's discussion. Audited (skill.discussion_message_deleted);
// the body is never recorded. No edits and no author self-delete anywhere.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../../lib/access";
import { findSkill } from "../../../../../../../lib/catalog";
import { deleteSkillDiscussionMessage, type SkillDiscussionSkill } from "../../../../../../../lib/messages";
import { enforceRateLimit } from "../../../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(_req: Request, ctx: { params: Promise<{ ns: string; slug: string; messageId: string }> }) {
  const { ns, slug, messageId } = await ctx.params;
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  if (!UUID.test(messageId)) return Response.json({ error: "valid messageId required" }, { status: 422 });

  const found = await findSkill(ns, slug);
  if (!found) return Response.json({ error: "not found" }, { status: 404 });
  const limited = enforceRateLimit("messages", access.userId, 60);
  if (limited) return limited;

  const skill: SkillDiscussionSkill = {
    id: found.id,
    namespaceId: found.namespaceId,
    namespaceSlug: found.namespaceSlug,
    skillSlug: found.slug,
    visibility: found.visibility,
    archived: found.status === "archived",
  };
  // Authority (and skill-thread membership) is re-verified inside deleteSkillDiscussionMessage.
  const r = await deleteSkillDiscussionMessage(access, skill, messageId);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json({ ok: true });
}
