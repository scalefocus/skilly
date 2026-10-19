// Release a QUARANTINED version (SKILLY_SPEC.md §49.2): a pointer mirror whose scan verdict was
// `critical` was inserted as `quarantined` — never latest, never synthesized, never served. A
// platform admin or an admin of the owning namespace may release it with a reason (audited as
// `skill.version_released`, carrying the findings); the publish sweep then synthesizes it.
// 404 invisible (§49.4), 403 unauthorized, 409 not quarantined, 422 missing reason.
import { currentAccess } from "../../../../../../../../lib/guard";
import { pool } from "../../../../../../../../lib/db";
import { releaseQuarantinedVersion } from "../../../../../../../../lib/manage";
import { enforceRateLimit } from "../../../../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string; semver: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("release", access.userId, 30);
  if (limited) return limited;
  const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
  const { ns, slug, semver } = await ctx.params;
  const r = await releaseQuarantinedVersion(pool, {
    access,
    actorUserId: access.userId,
    namespaceSlug: ns,
    skillSlug: slug,
    semver,
    reason: typeof body.reason === "string" ? body.reason : "",
  });
  return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: r.status });
}
