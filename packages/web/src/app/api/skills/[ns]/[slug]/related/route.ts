// "Skills you might like" (§10): up to 3 co-installed skills for this one, visibility-filtered per
// viewer. Read-only; reads the nightly precompute (related_skills). Returns catalog-card entries.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { findSkill, relatedSkills } from "../../../../../../lib/catalog";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);

  const { ns, slug } = await ctx.params;
  const skill = await findSkill(ns, slug);
  // No leak: an invisible (or archived, or missing) skill returns 404 exactly like the detail route.
  if (!skill || skill.status === "archived" || !isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility })) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const { related, allInstalled } = await relatedSkills(access, skill.id, access.userId, 3);
  return Response.json({ related, allInstalled });
}
