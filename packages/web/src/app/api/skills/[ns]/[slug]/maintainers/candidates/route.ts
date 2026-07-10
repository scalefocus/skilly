// Eligible-user typeahead for the maintainer picker (SKILLY_SPEC.md §19). Restricted to
// managers; returns only synced users who could be maintainers (pass the visibility gate)
// and aren't already maintaining the skill.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../../lib/access";
import { findSkill } from "../../../../../../../lib/catalog";
import { canManageMaintainers, listCandidates } from "../../../../../../../lib/maintainers";
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
  if (!isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility })) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (!(await canManageMaintainers(access, skill, access.userId))) return Response.json({ error: "not allowed" }, { status: 403 });

  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return Response.json({ candidates: [] });
  const candidates = await listCandidates(skill, q);
  return Response.json({ candidates });
}
