// Dismiss one (version, rule) policy flag as a false positive or an accepted exception
// (SKILLY_SPEC.md §47.8). Namespace override holders for a namespace rule; platform admins only for
// a platform rule. 409 when the rule isn't currently flagged for the version. Audited as
// skill.policy_flag_dismissed.
import { currentAccess } from "../../../../../../../lib/guard";
import { findSkill } from "../../../../../../../lib/catalog";
import { dismissPolicyFlag } from "../../../../../../../lib/policy";
import { enforceRateLimit } from "../../../../../../../lib/ratelimit";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("policy-dismiss", access.userId, 60);
  if (limited) return limited;
  const { ns, slug } = await ctx.params;
  const skill = await findSkill(ns, slug);
  if (!skill || skill.status !== "active" || !isSkillVisible(access, skill)) return Response.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const r = await dismissPolicyFlag(access, access.userId, { id: skill.id, namespaceId: skill.namespaceId, slug: skill.slug }, body);
  return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: r.status });
}
