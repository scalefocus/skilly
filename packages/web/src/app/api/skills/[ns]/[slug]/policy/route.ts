// The owner Policy card (SKILLY_SPEC.md §47.9, §47.11): one version's policy results, dismissals
// and the other flagged versions. Owners only — effective maintainers, namespace admins of the
// skill's namespace and platform admins (shadow results for the admins only). 403 for anyone else
// who can see the skill; 404 when it isn't visible.
import { currentAccess } from "../../../../../../lib/guard";
import { findSkill } from "../../../../../../lib/catalog";
import { canManageMaintainers } from "../../../../../../lib/maintainers";
import { skillPolicyDetail } from "../../../../../../lib/policy";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { ns, slug } = await ctx.params;
  const skill = await findSkill(ns, slug);
  if (!skill) return Response.json({ error: "not found" }, { status: 404 });
  const owner = await canManageMaintainers(access, { id: skill.id, namespaceId: skill.namespaceId, visibility: skill.visibility }, access.userId);
  const visible = skill.status === "archived" ? owner : isSkillVisible(access, skill);
  if (!visible) return Response.json({ error: "not found" }, { status: 404 });
  if (!owner) return Response.json({ error: "only this skill's maintainers and admins can see its policy check" }, { status: 403 });
  const detail = await skillPolicyDetail(access, { id: skill.id, namespaceId: skill.namespaceId }, new URL(req.url).searchParams.get("semver"));
  if (!detail) return Response.json({ error: "no active version" }, { status: 404 });
  return Response.json(detail);
}
