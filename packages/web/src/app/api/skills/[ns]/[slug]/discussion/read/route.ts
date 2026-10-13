// The Discussion card's read action (SKILLY_SPEC.md §24): fired by the client when the EXPANDED
// card's thread actually enters the viewport — never on page load, expand-by-default, or poll.
// Clears the caller's coalesced `skill.discussion` alert AND their `message.mention` rows for
// this skill's discussion — or, with `{ rootIds }`, their `skill.discussion_reply` rows for just
// those threads (each fired when that thread enters the viewport, §24 Replies). Same visibility gate as the discussion endpoints (404, no leak).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../../lib/access";
import { findSkill } from "../../../../../../../lib/catalog";
import { canManageMaintainers } from "../../../../../../../lib/maintainers";
import { canReadSkill, markSkillDiscussionRead, markSkillDiscussionThreadsRead, type SkillDiscussionSkill } from "../../../../../../../lib/messages";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  const { ns, slug } = await ctx.params;
  const found = await findSkill(ns, slug);
  if (!found) return Response.json({ error: "not found" }, { status: 404 });
  const skill: SkillDiscussionSkill = {
    id: found.id, namespaceId: found.namespaceId, namespaceSlug: found.namespaceSlug,
    skillSlug: found.slug, visibility: found.visibility, archived: found.status === "archived",
    sharedNamespaceIds: found.sharedNamespaceIds,
  };
  const isOwner = skill.archived
    ? await canManageMaintainers(access, { id: skill.id, namespaceId: skill.namespaceId, visibility: skill.visibility }, access.userId)
    : false;
  if (!canReadSkill(access, skill, isOwner)) return Response.json({ error: "not found" }, { status: 404 }); // no leak

  // `{ rootIds }` is the per-thread read of skill.discussion_reply rows (§24 Replies); without it
  // this is the whole-card read of skill.discussion + mention rows.
  const body = (await req.json().catch(() => ({}))) as { rootIds?: unknown };
  if (body.rootIds !== undefined) {
    if (!Array.isArray(body.rootIds) || body.rootIds.length > 100 || !body.rootIds.every((id) => typeof id === "string" && UUID.test(id))) {
      return Response.json({ error: "rootIds must be up to 100 comment ids" }, { status: 422 });
    }
    await markSkillDiscussionThreadsRead(access, skill, body.rootIds as string[]);
    return Response.json({ ok: true });
  }
  await markSkillDiscussionRead(access, skill);
  return Response.json({ ok: true });
}
