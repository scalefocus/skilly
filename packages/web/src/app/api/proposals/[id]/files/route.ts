// Browse an uploaded proposal bundle during review (SKILLY_SPEC.md §8). Gated EXACTLY like the
// proposal detail + bundle download (reviewer of the namespace or the submitter — 404 otherwise,
// so restricted proposals never leak).
//
//   GET /api/proposals/:id/files            -> { available, files: [{path,size,isText}] }
//   GET /api/proposals/:id/files?path=X      -> that file's bytes (text/plain inline for text;
//                                               octet-stream attachment otherwise)
//   GET /api/proposals/:id/files?path=X&download=1 -> force attachment (download a text file too)
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../lib/access";
import { pool } from "../../../../../lib/db";
import { getProposalDetail } from "../../../../../lib/proposals";
import { enforceRateLimit } from "../../../../../lib/ratelimit";
import { loadBundleEntries, listBundleFiles, isTextFile } from "../../../../../lib/bundleBrowse";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("download", access.userId, 120);
  if (limited) return limited;

  const detail = await getProposalDetail(pool, (await ctx.params).id, access, access.userId);
  if (!detail) return Response.json({ error: "not found" }, { status: 404 });

  const latest = detail.revisions.at(-1);
  const key = latest?.payload.artifactObjectKey;
  if (!key) {
    // Pointer source (or nothing uploaded): no bundle to browse. The upstream is mirrored only
    // on acceptance, so there are no files to show here yet.
    return Response.json({ available: false, kind: latest?.payload.pointer ? "pointer" : "none" });
  }

  let entries;
  try {
    entries = await loadBundleEntries(key);
  } catch (e) {
    return Response.json({ available: false, kind: "error", error: String((e as Error).message ?? e) });
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path) {
    return Response.json({ available: true, files: listBundleFiles(entries) });
  }

  // Exact match against an extracted entry — there's no way to express path traversal, since the
  // path must equal a real, junk-filtered, prefix-stripped entry produced by extractBundle.
  const entry = entries.find((e) => e.path === path);
  if (!entry) return Response.json({ error: "file not found in bundle" }, { status: 404 });

  const bytes = new Uint8Array(entry.bytes);
  const filename = (path.split("/").pop() || "file").replace(/["\\]/g, "");
  // Never serve bundle content as an active type: text goes back as text/plain (inline), everything
  // else as an attachment. nosniff stops the browser guessing a richer type — a stored .html/.svg
  // can never execute.
  if (isTextFile(entry.bytes) && url.searchParams.get("download") !== "1") {
    return new Response(bytes, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-length": String(bytes.length),
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  }
  return new Response(bytes, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(bytes.length),
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}
