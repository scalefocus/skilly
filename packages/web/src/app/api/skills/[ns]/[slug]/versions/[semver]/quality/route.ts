// One version's quality detail (SKILLY_SPEC.md §41.11): score, mode, findings and the AI verdict.
// Visibility-filtered like the skill page (404, never 403); archived skills owner-only (§7).
import { currentAccess } from "../../../../../../../../lib/guard";
import { findSkill } from "../../../../../../../../lib/catalog";
import { canManageMaintainers } from "../../../../../../../../lib/maintainers";
import { skillQualityDetail } from "../../../../../../../../lib/quality";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ ns: string; slug: string; semver: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { ns, slug, semver } = await ctx.params;
  const skill = await findSkill(ns, slug);
  if (!skill) return Response.json({ error: "not found" }, { status: 404 });
  const ref = { id: skill.id, namespaceId: skill.namespaceId, visibility: skill.visibility };
  const visible = skill.status === "archived" ? await canManageMaintainers(access, ref, access.userId) : isSkillVisible(access, ref);
  if (!visible) return Response.json({ error: "not found" }, { status: 404 });
  const detail = await skillQualityDetail(access, skill, semver);
  return Response.json({ quality: detail });
}
