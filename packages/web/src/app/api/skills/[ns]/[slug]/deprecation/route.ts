// Deprecate / edit / un-deprecate a skill (SKILLY_SPEC.md §45.3, §45.8, §15).
//   PUT    { successor: "<ns>/<slug>" | null, note: string | null } → 200 { deprecation }
//   DELETE                                                          → 204 (idempotent)
// Authority = archive's: platform admin, or an admin of the OWNING namespace. 404 when the caller
// can't see the skill (no leak, #3); 403 visible-but-unauthorized; 409 archived; 422 ineligible
// successor (not_found · self · archived · deprecated · audience) or an over-long note.
import { currentAccess } from "../../../../../../lib/guard";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";
import { pool } from "../../../../../../lib/db";
import { setSkillDeprecation, clearSkillDeprecation } from "../../../../../../lib/deprecation";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ ns: string; slug: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("deprecate", access.userId, 30);
  if (limited) return limited;
  const body = (await req.json().catch(() => ({}))) as { successor?: unknown; note?: unknown };
  const successor = typeof body.successor === "string" && body.successor.trim() ? body.successor.trim() : null;
  if (body.successor != null && typeof body.successor !== "string") return Response.json({ error: "successor must be \"<ns>/<slug>\" or null" }, { status: 422 });
  const { ns, slug } = await ctx.params;
  const r = await setSkillDeprecation(pool, { access, actorUserId: access.userId, namespaceSlug: ns, skillSlug: slug, successor, note: body.note ?? null });
  if (!r.ok) return Response.json({ error: r.error, reason: r.reason ?? null }, { status: r.status });
  return Response.json({ ok: true, deprecation: r.deprecation, notified: r.changedSuccessor });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("deprecate", access.userId, 30);
  if (limited) return limited;
  const { ns, slug } = await ctx.params;
  const r = await clearSkillDeprecation(pool, { access, actorUserId: access.userId, namespaceSlug: ns, skillSlug: slug });
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return new Response(null, { status: 204 });
}
