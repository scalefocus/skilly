// A version's signed statements (SKILLY_SPEC.md §73.10).
//
//   GET .../versions/:semver/statement           -> { registry, semver, status, statements[], otherVersions[] }
//   GET .../versions/:semver/statement?download=1[&variant=<first 8 hex of inputsSha256>]
//                                                -> the bare DSSE envelope as an attachment
//
// Visibility first (404, invariant #3); 409 statement_pending while none exists yet. Statements are
// metadata (paths + hashes), never bytes.
import { currentAccess } from "../../../../../../../../lib/guard";
import { enforceRateLimit } from "../../../../../../../../lib/ratelimit";
import { canonicalSkillParams } from "../../../../../../../../lib/skillMoves";
import { statementPayload, visibleSkillForVersion } from "../../../../../../../../lib/signing";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ ns: string; slug: string; semver: string }> }): Promise<Response> {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("statement", access.userId, 120);
  if (limited) return limited;

  const { ns, slug, semver } = await canonicalSkillParams(ctx.params);
  const skill = await visibleSkillForVersion(access, ns, slug, semver);
  if (!skill) return Response.json({ error: "not found" }, { status: 404 });
  const found = await statementPayload(skill.id, semver);
  if (!found) return Response.json({ error: "not found" }, { status: 404 });
  const { payload } = found;
  if (payload.statements.length === 0) {
    return Response.json({ error: "statement_pending", message: "This version has no signed statement yet." }, { status: 409 });
  }

  const url = new URL(req.url);
  if (url.searchParams.get("download") === "1") {
    const want = url.searchParams.get("variant");
    const st = want
      ? payload.statements.find((s) => s.variant && s.variant.inputsSha256.startsWith(want.toLowerCase()) && /^[0-9a-f]{8}$/i.test(want))
      : payload.statements.find((s) => !s.variant);
    if (!st) return Response.json({ error: "not found" }, { status: 404 });
    const name = st.variant ? `${skill.slug}-${semver}.variant-${st.variant.inputsSha256.slice(0, 8)}.intoto.json` : `${skill.slug}-${semver}.intoto.json`;
    return new Response(JSON.stringify(st.envelope, null, 2) + "\n", {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name.replace(/[^A-Za-z0-9._+-]/g, "_")}"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
}
