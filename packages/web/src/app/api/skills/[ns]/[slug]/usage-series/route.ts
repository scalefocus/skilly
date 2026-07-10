// Per-skill views+installs time series for the detail-page trend chart (SKILLY_SPEC.md §21).
// Visible to ANYONE who can open the skill — same access rules as the detail page itself: an
// active skill requires only visibility (#3 — a restricted skill the caller can't see 404s, no
// leak); an archived skill is owner-only (its existence is owner-only, §7). This is aggregate
// counts over time only — the PII breakdown (named viewers/installers) stays owner-only on /usage.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { findSkill } from "../../../../../../lib/catalog";
import { canManageMaintainers } from "../../../../../../lib/maintainers";
import { getSkillSeries, SERIES_RANGES, type SeriesRange } from "../../../../../../lib/usage";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  const { ns, slug } = await ctx.params;
  const skill = await findSkill(ns, slug);
  if (!skill) return Response.json({ error: "not found" }, { status: 404 });
  if (skill.status === "archived") {
    // Archived skills are withdrawn from the catalog — only owners may open them (§7), so the
    // chart follows: non-owners 404 (no leak), exactly like the detail route.
    const owner = await canManageMaintainers(access, skill, access.userId);
    if (!owner) return Response.json({ error: "not found" }, { status: 404 });
  } else if (!isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility })) {
    return Response.json({ error: "not found" }, { status: 404 }); // no leak
  }

  const r = new URL(req.url).searchParams.get("range") as SeriesRange | null;
  const range: SeriesRange = r && SERIES_RANGES.includes(r) ? r : "30d";
  return Response.json(await getSkillSeries(skill.id, skill.createdAt, range));
}
