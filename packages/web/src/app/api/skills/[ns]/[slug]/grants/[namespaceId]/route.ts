// Add (PUT) / revoke (DELETE) one shared namespace on a restricted skill (SKILLY_SPEC.md §42.2, §15).
// Idempotent. Authority per the §4 matrix: share = platform admin · owning-namespace admin · an
// explicit maintainer; revoke = the same, plus an admin of the RECEIVING namespace.
// 404 when the caller can't see the skill (no leak, #3); 403 when visible but unauthorized;
// 409 when the skill is org-visible or archived, or the target is the owner / global; 422 unknown ns.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../../lib/access";
import { findSkill } from "../../../../../../../lib/catalog";
import { enforceRateLimit } from "../../../../../../../lib/ratelimit";
import { pool } from "../../../../../../../lib/db";
import { addGrant, removeGrant, inTransaction, isExplicitMaintainer, validateGrantTargets, GRANT_TARGET_MESSAGES, listGrants } from "../../../../../../../lib/grants";
import { canShareSkill, canUnshareSkill, isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ ns: string; slug: string; namespaceId: string }> };

async function prepare(ctx: Ctx) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return { error: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  const access = await resolveUserAccess(oid);
  if (!access.userId) return { error: Response.json({ error: "unknown user" }, { status: 403 }) };
  const limited = enforceRateLimit("grants", access.userId, 60);
  if (limited) return { error: limited };

  const { ns, slug, namespaceId } = await ctx.params;
  const skill = await findSkill(ns, slug);
  if (!skill || (skill.status === "active" && !isSkillVisible(access, skill))) {
    return { error: Response.json({ error: "not found" }, { status: 404 }) };
  }
  if (skill.status === "archived") return { error: Response.json({ error: "an archived skill's sharing can't change — restore it first" }, { status: 409 }) };
  if (skill.visibility !== "namespace") {
    return { error: Response.json({ error: "only a namespace-restricted skill can be shared — an org skill is already visible to everyone" }, { status: 409 }) };
  }
  const maintainer = await isExplicitMaintainer(skill.id, access.userId);
  return { access, userId: access.userId, skill, namespaceId, maintainer };
}

export async function PUT(_req: Request, ctx: Ctx) {
  const p = await prepare(ctx);
  if ("error" in p) return p.error;
  if (!canShareSkill(p.access, p.skill.namespaceId, p.maintainer)) {
    return Response.json({ error: "only the skill's namespace admins or maintainers can share it" }, { status: 403 });
  }
  const v = await validateGrantTargets(pool, p.skill.namespaceId, [p.namespaceId]);
  if (!v.ok) return Response.json({ error: GRANT_TARGET_MESSAGES[v.error] }, { status: v.error === "unknown_namespace" ? 422 : 409 });
  const added = await inTransaction((client) => addGrant(client, p.skill, p.namespaceId, p.userId, "manage"));
  return Response.json({ ok: true, added, grants: await listGrants(p.skill.id) });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const p = await prepare(ctx);
  if ("error" in p) return p.error;
  if (!canUnshareSkill(p.access, p.skill.namespaceId, p.namespaceId, p.maintainer)) {
    return Response.json({ error: "you can't remove this namespace's access to the skill" }, { status: 403 });
  }
  const out = await inTransaction((client) => removeGrant(client, p.skill, p.namespaceId, p.userId, "manage"));
  return Response.json({ ok: true, removed: out.removed, prunedMaintainers: out.prunedMaintainers.length, grants: await listGrants(p.skill.id) });
}
