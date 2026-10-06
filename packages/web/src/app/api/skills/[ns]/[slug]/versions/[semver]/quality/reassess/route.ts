// Re-assess one version's quality (SKILLY_SPEC.md §41.8). Override authority only (namespace
// admin of the skill's namespace, or a platform admin); re-runs the rules now, queues the AI part
// for the worker sweep. Audited as skill.quality_reassess_requested.
import { currentAccess } from "../../../../../../../../../lib/guard";
import { findSkill } from "../../../../../../../../../lib/catalog";
import { reassessQuality } from "../../../../../../../../../lib/quality";
import { enforceRateLimit } from "../../../../../../../../../lib/ratelimit";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ ns: string; slug: string; semver: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("quality-reassess", access.userId, 10);
  if (limited) return limited;
  const { ns, slug, semver } = await ctx.params;
  const skill = await findSkill(ns, slug);
  if (!skill || skill.status !== "active" || !isSkillVisible(access, skill)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const r = await reassessQuality(access, access.userId, { id: skill.id, namespaceId: skill.namespaceId, slug: skill.slug }, semver);
  return r.ok ? Response.json({ quality: r.detail }) : Response.json({ error: r.error }, { status: r.status });
}
