// People typeahead (SKILLY_SPEC.md §24 "Mentions", §10 people mode). Backs the composer `@`
// picker and the header search's leading-`@` mode. Any signed-in user (people have no per-user
// visibility model — §28 precedent); hardened like /api/skills/suggest: 2-char floor before any
// query, tight rate limit, bounded result set. The optional `context` narrows candidates to the
// thread's mentionable set — `proposal:<id>` (the review thread's audience; a caller who can't
// see the proposal 404s, no leak) or `skill:<ns>/<slug>` (the skill's viewers; org-visible skills
// fall through to the whole directory). Erased and non-active users are never returned.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { enforceRateLimit } from "../../../../lib/ratelimit";
import { suggestUsers, type MentionAudience } from "../../../../lib/mentions";
import { proposalMentionAudience, canReadSkill, type SkillDiscussionSkill } from "../../../../lib/messages";
import { findSkill } from "../../../../lib/catalog";
import { canManageMaintainers } from "../../../../lib/maintainers";

export const dynamic = "force-dynamic";

const MIN_CHARS = 2;
const MAX_CHARS = 64;

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const url = new URL(req.url);
  const raw = (url.searchParams.get("q") ?? "").trim();
  if (raw.length < MIN_CHARS) return Response.json({ users: [] });

  const limited = enforceRateLimit("users-suggest", oid, 40);
  if (limited) return limited;

  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  // Resolve the optional thread context to a mentionable-set audience (§24).
  let audience: MentionAudience | null = null;
  const context = url.searchParams.get("context");
  if (context?.startsWith("proposal:")) {
    audience = await proposalMentionAudience(access, context.slice("proposal:".length));
    if (!audience) return Response.json({ error: "not found" }, { status: 404 }); // no leak
  } else if (context?.startsWith("skill:")) {
    const [ns, slug] = context.slice("skill:".length).split("/");
    const found = ns && slug ? await findSkill(ns, slug) : null;
    if (!found) return Response.json({ error: "not found" }, { status: 404 });
    const skill: SkillDiscussionSkill = {
      id: found.id, namespaceId: found.namespaceId, namespaceSlug: found.namespaceSlug,
      skillSlug: found.slug, visibility: found.visibility, archived: found.status === "archived",
    };
    const isOwner = skill.archived
      ? await canManageMaintainers(access, { id: skill.id, namespaceId: skill.namespaceId, visibility: skill.visibility }, access.userId)
      : false;
    if (!canReadSkill(access, skill, isOwner)) return Response.json({ error: "not found" }, { status: 404 }); // no leak
    audience = { kind: "skill", namespaceId: skill.namespaceId, visibility: skill.visibility };
  }

  const limit = Math.min(6, Math.max(1, Number(url.searchParams.get("limit") ?? 6) || 6));
  const users = await suggestUsers(raw.slice(0, MAX_CHARS), audience, limit);
  return Response.json({ users });
}
