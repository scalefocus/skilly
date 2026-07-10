// Download a proposal's hosted bundle for review. Gated exactly like the proposal detail
// (reviewer of the namespace or the submitter — 404 otherwise, so restricted proposals
// never leak). Streams the immutable uploaded artifact; not an install, not counted.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../lib/access";
import { pool } from "../../../../../lib/db";
import { getProposalDetail } from "../../../../../lib/proposals";
import { s3ArtifactStore } from "../../../../../lib/objectStore";
import { enforceRateLimit } from "../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

/** The upload endpoint stores raw bytes under an opaque ".bundle" key — sniff the real format. */
function sniffFormat(bytes: Buffer): { ext: string; mime: string } {
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return { ext: "zip", mime: "application/zip" };
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return { ext: "tar.gz", mime: "application/gzip" };
  return { ext: "bin", mime: "application/octet-stream" };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("download", access.userId, 60);
  if (limited) return limited;

  const detail = await getProposalDetail(pool, (await ctx.params).id, access, access.userId);
  if (!detail) return Response.json({ error: "not found" }, { status: 404 });

  const latest = detail.revisions.at(-1);
  const key = latest?.payload.artifactObjectKey;
  if (!key) return Response.json({ error: "this proposal has no hosted bundle (pointer source)" }, { status: 404 });

  const bytes = await s3ArtifactStore().get(key);
  const fmt = sniffFormat(bytes);
  const slug = latest!.payload.metadata?.skillSlug ?? "proposal";
  const filename = `${slug}-${detail.proposedSemver}-rev${latest!.revisionNo}.${fmt.ext}`;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": fmt.mime,
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(bytes.length),
      "cache-control": "no-store",
    },
  });
}
