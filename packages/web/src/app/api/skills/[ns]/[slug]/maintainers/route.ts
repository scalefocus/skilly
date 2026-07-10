// Skill maintainers (SKILLY_SPEC.md §19). GET = effective list (anyone who can see the
// skill). PUT {userId} adds and DELETE {userId} removes — both allowed for a platform admin,
// the namespace admin, or any of the skill's own maintainers (self-removal always allowed).
// All bounded by the visibility eligibility gate.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { findSkill } from "../../../../../../lib/catalog";
import { getEffectiveMaintainers, canManageMaintainers, canRemoveMaintainer, addMaintainer, removeMaintainer } from "../../../../../../lib/maintainers";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function authorize(ns: string, slug: string) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return { error: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  const access = await resolveUserAccess(oid);
  if (!access.userId) return { error: Response.json({ error: "unknown user" }, { status: 403 }) };

  const skill = await findSkill(ns, slug);
  if (!skill || skill.status === "archived") return { error: Response.json({ error: "not found" }, { status: 404 }) };
  if (!isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility })) {
    return { error: Response.json({ error: "not found" }, { status: 404 }) }; // no leak (#3)
  }
  return { access, userId: access.userId, skill };
}

export async function GET(_req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const a = await authorize((await ctx.params).ns, (await ctx.params).slug);
  if ("error" in a) return a.error;
  const maintainers = await getEffectiveMaintainers(a.skill);
  const canManage = await canManageMaintainers(a.access, a.skill, a.userId);
  // Anyone who can manage the list (platform admin / ns admin / a maintainer of this skill) may
  // remove any explicit maintainer (§19); the UI also shows the remove button on the caller's own
  // card regardless. `canRemoveOthers` therefore equals `canManage`.
  return Response.json({ maintainers, canManage, canRemoveOthers: canManage, userId: a.userId });
}

export async function PUT(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const a = await authorize((await ctx.params).ns, (await ctx.params).slug);
  if ("error" in a) return a.error;
  if (!(await canManageMaintainers(a.access, a.skill, a.userId))) return Response.json({ error: "not allowed to manage maintainers" }, { status: 403 });
  const limited = enforceRateLimit("maintainers", a.userId, 60);
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as { userId?: unknown };
  if (typeof body.userId !== "string" || !UUID.test(body.userId)) return Response.json({ error: "valid userId required" }, { status: 422 });
  const err = await addMaintainer(a.userId, a.skill, body.userId);
  if (err) return Response.json(err, { status: 422 });
  return Response.json({ ok: true });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const a = await authorize((await ctx.params).ns, (await ctx.params).slug);
  if ("error" in a) return a.error;
  const limited = enforceRateLimit("maintainers", a.userId, 60);
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as { userId?: unknown };
  if (typeof body.userId !== "string" || !UUID.test(body.userId)) return Response.json({ error: "valid userId required" }, { status: 422 });
  // A platform admin, the namespace admin, or any of the skill's maintainers may remove an
  // explicit maintainer; self-removal is always allowed. §19.
  if (!(await canRemoveMaintainer(a.access, a.skill, a.userId, body.userId))) {
    return Response.json({ error: "only a platform admin, a namespace admin, or one of the skill's maintainers can remove a maintainer" }, { status: 403 });
  }
  await removeMaintainer(a.userId, a.skill, body.userId);
  return Response.json({ ok: true });
}
