// Server-side verification for scripts (SKILLY_SPEC.md §73.10): the caller sends paths + sha256
// (never contents) and gets the §73.7 verdict with the signature checked here.
//   POST .../versions/:semver/verify  { files: [{ path, sha256, lfSha256?, mode? }] }  (≤ 5,000)
import { parseLocalFiles } from "@skilly/shared";
import { currentAccess } from "../../../../../../../../lib/guard";
import { enforceRateLimit } from "../../../../../../../../lib/ratelimit";
import { canonicalSkillParams } from "../../../../../../../../lib/skillMoves";
import { verifyOnServer, visibleSkillForVersion } from "../../../../../../../../lib/signing";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string; semver: string }> }): Promise<Response> {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("verify", access.userId, 60);
  if (limited) return limited;

  const { ns, slug, semver } = await canonicalSkillParams(ctx.params);
  const skill = await visibleSkillForVersion(access, ns, slug, semver);
  if (!skill) return Response.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { files?: unknown } | null;
  const local = parseLocalFiles(body?.files);
  if (typeof local === "string") return Response.json({ error: local }, { status: 422 });

  const verdict = await verifyOnServer(skill.id, semver, local);
  if (verdict === null) return Response.json({ error: "not found" }, { status: 404 });
  if (verdict === "pending") return Response.json({ error: "statement_pending", message: "This version has no signed statement yet." }, { status: 409 });
  return Response.json(verdict);
}
