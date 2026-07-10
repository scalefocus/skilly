// SKILL.md content for a skill (visibility-enforced). Lazy-loaded by the detail page.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { findSkill } from "../../../../../../lib/catalog";
import { readSkillReadme } from "../../../../../../lib/readme";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  // Each call re-fetches + re-extracts the artifact (sync unzip). Limit to blunt a CPU/event-loop
  // DoS from hammering a near-max bundle. Audit P1 (web #4).
  if (access.userId) {
    const limited = enforceRateLimit("readme", access.userId, 120);
    if (limited) return limited;
  }

  const skill = await findSkill((await ctx.params).ns, (await ctx.params).slug);
  if (!skill || skill.status === "archived") return Response.json({ error: "not found" }, { status: 404 });
  if (!isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility })) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const semver = new URL(req.url).searchParams.get("semver") ?? undefined;
  const readme = await readSkillReadme(skill.id, semver);
  if (!readme) return Response.json({ error: "no SKILL.md available" }, { status: 404 });
  return Response.json(readme);
}
