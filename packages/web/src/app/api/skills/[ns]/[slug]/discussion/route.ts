// The skill detail page's Discussion card (SKILLY_SPEC.md §24 "Skill discussion"). GET returns a
// newest-first page of top-level comments, each with all of its replies (100/page; lazy — empty
// + null conversationId until someone posts); POST get-or-creates the conversation and posts a
// comment (≤500 chars) stamped with the chosen version, or — with `parentId` — a reply into that
// comment's thread (§24 Replies). Read/post = anyone who can see the skill (archived →
// owner-only, read-only).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { findSkill } from "../../../../../../lib/catalog";
import { canManageMaintainers } from "../../../../../../lib/maintainers";
import { getSkillDiscussion, postSkillDiscussionMessage, canReadSkill, type SkillDiscussionSkill } from "../../../../../../lib/messages";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function authorize(ns: string, slug: string) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return { error: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  const access = await resolveUserAccess(oid);
  if (!access.userId) return { error: Response.json({ error: "unknown user" }, { status: 403 }) };

  const found = await findSkill(ns, slug);
  if (!found) return { error: Response.json({ error: "not found" }, { status: 404 }) };
  const skill: SkillDiscussionSkill = {
    id: found.id,
    namespaceId: found.namespaceId,
    namespaceSlug: found.namespaceSlug,
    skillSlug: found.slug,
    visibility: found.visibility,
    archived: found.status === "archived",
    sharedNamespaceIds: found.sharedNamespaceIds,
  };
  // Archived skills are owner-only (§7); otherwise the skill's own visibility applies (#3).
  const isOwner = skill.archived
    ? await canManageMaintainers(access, { id: skill.id, namespaceId: skill.namespaceId, visibility: skill.visibility }, access.userId)
    : false;
  if (!canReadSkill(access, skill, isOwner)) return { error: Response.json({ error: "not found" }, { status: 404 }) }; // no leak
  return { access, userId: access.userId, skill };
}

export async function GET(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const a = await authorize((await ctx.params).ns, (await ctx.params).slug);
  if ("error" in a) return a.error;
  const offset = Math.max(0, Number(new URL(req.url).searchParams.get("offset") ?? 0) || 0);
  const thread = await getSkillDiscussion(a.access, a.skill, { offset });
  return Response.json(thread);
}

export async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const a = await authorize((await ctx.params).ns, (await ctx.params).slug);
  if ("error" in a) return a.error;
  const limited = enforceRateLimit("messages", a.userId, 60);
  if (limited) return limited;
  const body = (await req.json().catch(() => ({}))) as { body?: string; contextSemver?: unknown; parentId?: unknown };
  const semver = typeof body.contextSemver === "string" && body.contextSemver ? body.contextSemver : null;
  // §24 Replies: an optional parentId (normalised to its thread's root server-side).
  let parentId: string | null = null;
  if (body.parentId != null) {
    if (typeof body.parentId !== "string" || !UUID.test(body.parentId)) return Response.json({ error: "parentId must be a comment id" }, { status: 422 });
    parentId = body.parentId;
  }
  const r = await postSkillDiscussionMessage(a.access, a.skill, body.body ?? "", semver, parentId);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json({ conversationId: r.conversationId, message: r.message }, { status: 201 });
}
