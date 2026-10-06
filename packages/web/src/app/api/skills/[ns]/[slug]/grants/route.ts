// The skill's shared namespaces (SKILLY_SPEC.md §42, §15). GET → { grants, canManage, canRevoke }.
// Visible to anyone who can see the skill (404 otherwise — no leak, invariant #3); an archived skill
// is owner-only, exactly like the detail page (§7).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { findSkill } from "../../../../../../lib/catalog";
import { canManageMaintainers } from "../../../../../../lib/maintainers";
import { listGrants, isExplicitMaintainer } from "../../../../../../lib/grants";
import { canShareSkill, canUnshareSkill, isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  const { ns, slug } = await ctx.params;
  const skill = await findSkill(ns, slug);
  if (!skill) return Response.json({ error: "not found" }, { status: 404 });
  const visible = skill.status === "archived" ? await canManageMaintainers(access, skill, access.userId) : isSkillVisible(access, skill);
  if (!visible) return Response.json({ error: "not found" }, { status: 404 });

  const grants = await listGrants(skill.id);
  const maintainer = await isExplicitMaintainer(skill.id, access.userId);
  const editable = skill.visibility === "namespace" && skill.status === "active";
  const canManage = editable && canShareSkill(access, skill.namespaceId, maintainer);
  // Per-chip revoke right: the sharers, plus a receiving namespace's admin for their own chip.
  const canRevoke = editable ? grants.filter((g) => canUnshareSkill(access, skill.namespaceId, g.namespaceId, maintainer)).map((g) => g.namespaceId) : [];
  return Response.json({ grants, canManage, canRevoke });
}
