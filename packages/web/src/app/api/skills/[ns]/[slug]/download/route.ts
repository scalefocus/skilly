// Download a skill version as a file (governed, visibility-checked). Streams the ORIGINAL uploaded
// bundle verbatim with its original extension (.skill/.zip/.tar.gz; §6/§10). NOT a git-clone
// install, but a user's FIRST download of a skill counts toward install_count (deduped per
// (skill,user); never listed as an installation). Active non-yanked versions only; archived skills
// are owner-only (and never counted). SKILLY_SPEC.md §6, §10.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { findSkill } from "../../../../../../lib/catalog";
import { canManageMaintainers } from "../../../../../../lib/maintainers";
import { buildSkillDownload, DownloadFormatError, type DownloadFormat } from "../../../../../../lib/download";
import { recordFirstDownload } from "../../../../../../lib/installs";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";
import { isSkillVisible } from "@skilly/shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  // Fetches + extracts + re-packs the artifact — rate-limit like the readme path.
  const limited = enforceRateLimit("download", access.userId, 60);
  if (limited) return limited;

  const skill = await findSkill((await ctx.params).ns, (await ctx.params).slug);
  if (!skill) return Response.json({ error: "not found" }, { status: 404 });

  if (skill.status === "archived") {
    // Archived skills are withdrawn from the catalog: only owners may download (they can restore).
    const owner = await canManageMaintainers(access, { id: skill.id, namespaceId: skill.namespaceId, visibility: skill.visibility }, access.userId);
    if (!owner) return Response.json({ error: "not found" }, { status: 404 }); // no leak
  } else if (!isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility })) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const params = new URL(req.url).searchParams;
  const semver = params.get("semver") ?? undefined;
  // Optional explicit format (§6 "Pointer download format choice"): .skill re-packs a mirrored
  // tarball as a zip-based .skill bundle; .tar.gz streams the stored tarball verbatim.
  const rawFormat = params.get("format");
  if (rawFormat !== null && rawFormat !== "skill" && rawFormat !== "tar.gz") {
    return Response.json({ error: "unsupported format (expected skill or tar.gz)" }, { status: 400 });
  }
  const format = (rawFormat ?? undefined) as DownloadFormat | undefined;

  let dl;
  try {
    dl = await buildSkillDownload(skill.id, (await ctx.params).slug, semver, format);
  } catch (e) {
    if (e instanceof DownloadFormatError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
  if (!dl) return Response.json({ error: "no downloadable artifact for this version" }, { status: 404 });

  // A user's FIRST download of a skill counts toward install_count (deduped per (skill,user) —
  // subsequent downloads are no-ops). Owner-only archived downloads are NOT counted. Never blocks
  // the download: a counting failure is logged, not surfaced. SKILLY_SPEC.md §10.
  if (skill.status !== "archived") {
    try {
      await recordFirstDownload(skill.id, access.userId);
    } catch (e) {
      console.error(JSON.stringify({ level: "warn", msg: "record_skill_download failed (non-fatal)", err: String(e instanceof Error ? e.message : e) }));
    }
  }

  return new Response(new Uint8Array(dl.bytes), {
    status: 200,
    headers: {
      "content-type": dl.contentType,
      "content-disposition": `attachment; filename="${dl.filename}"`,
      "content-length": String(dl.bytes.length),
      "cache-control": "no-store",
    },
  });
}
