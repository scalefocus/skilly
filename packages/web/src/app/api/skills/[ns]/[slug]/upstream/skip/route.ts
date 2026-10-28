// Skip / un-skip a pending upstream release (SKILLY_SPEC.md §63.8). Effective maintainers and
// platform admins. POST { ref } → 200 { ref } · DELETE → 200 { ref }.
// 404 when the caller can't see the skill (never a probe) · 403 for other viewers ·
// 409 not_pending (POST: `ref` isn't the pending release) / not_skipped (DELETE: nothing skipped).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../../lib/access";
import { findSkill } from "../../../../../../../lib/catalog";
import { canManageMaintainers } from "../../../../../../../lib/maintainers";
import { enforceRateLimit } from "../../../../../../../lib/ratelimit";
import { skipUpstreamRelease, unskipUpstreamRelease } from "../../../../../../../lib/upstreamReleases";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ ns: string; slug: string }> };

/** The shared gate: signed in, the skill visible and active, and the caller one of its owners. */
async function authorize(ctx: Ctx) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return { error: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  const access = await resolveUserAccess(oid);
  if (!access.userId) return { error: Response.json({ error: "unknown user" }, { status: 403 }) };
  const limited = enforceRateLimit("upstream-skip", access.userId, 30);
  if (limited) return { error: limited };
  const { ns, slug } = await ctx.params;
  const skill = await findSkill(ns, slug);
  if (!skill || skill.status === "archived" || !isSkillVisible(access, skill)) {
    return { error: Response.json({ error: "not found" }, { status: 404 }) };
  }
  if (!(await canManageMaintainers(access, { id: skill.id, namespaceId: skill.namespaceId, visibility: skill.visibility }, access.userId))) {
    return { error: Response.json({ error: "only the skill's maintainers can skip an upstream release" }, { status: 403 }) };
  }
  return { access, userId: access.userId, skill };
}

export async function POST(req: Request, ctx: Ctx) {
  const a = await authorize(ctx);
  if ("error" in a) return a.error;
  const body = (await req.json().catch(() => null)) as { ref?: unknown } | null;
  const ref = typeof body?.ref === "string" ? body.ref : "";
  if (!ref.trim()) return Response.json({ error: "ref is required" }, { status: 422 });
  const r = await skipUpstreamRelease(
    { id: a.skill.id, namespaceId: a.skill.namespaceId, status: a.skill.status, deprecatedAt: a.skill.deprecatedAt },
    ref,
    a.userId,
  );
  if (!r.ok) return Response.json({ error: r.error, code: r.error }, { status: r.status });
  return Response.json({ ref: r.ref });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const a = await authorize(ctx);
  if ("error" in a) return a.error;
  const r = await unskipUpstreamRelease({ id: a.skill.id, namespaceId: a.skill.namespaceId }, a.userId);
  if (!r.ok) return Response.json({ error: r.error, code: r.error }, { status: r.status });
  return Response.json({ ref: r.ref });
}
