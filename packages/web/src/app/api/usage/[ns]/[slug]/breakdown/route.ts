// Per-skill usage drill-down (SKILLY_SPEC.md §21): top viewers/installers for a window,
// owner-only. Restricted skills the caller can't see return 404 (no leak); a visible skill the
// caller doesn't OWN returns 403.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { findSkill } from "../../../../../../lib/catalog";
import { canManageMaintainers } from "../../../../../../lib/maintainers";
import { getBreakdown, SERIES_RANGES, type SeriesRange } from "../../../../../../lib/usage";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  const skill = await findSkill((await ctx.params).ns, (await ctx.params).slug);
  if (!skill || skill.status === "archived") return Response.json({ error: "not found" }, { status: 404 });
  // Don't reveal a restricted skill's existence to a non-member (#3); then require ownership.
  if (!isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility })) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (!(await canManageMaintainers(access, skill, access.userId))) {
    return Response.json({ error: "usage is visible to skill owners only" }, { status: 403 });
  }

  const r = new URL(req.url).searchParams.get("range") as SeriesRange | null;
  const range: SeriesRange = r && SERIES_RANGES.includes(r) ? r : "30d";
  return Response.json({ range, ...(await getBreakdown(skill.id, skill.createdAt, range)) });
}
