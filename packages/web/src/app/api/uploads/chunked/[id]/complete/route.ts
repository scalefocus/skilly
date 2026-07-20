// Chunked hosted-bundle upload — COMPLETE (§6). Verifies every part, assembles in index order,
// and runs the IDENTICAL single-shot ingest pipeline (extract → blocking validation → advisory
// scan → verbatim store → artifact-keyed scan report → duplicate pre-check), answering with the
// same response shape as POST /api/uploads. The session + staged parts are deleted whatever the
// outcome — a retry starts a fresh session.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { getMaxBundleBytes } from "../../../../../../lib/settings";
import { withSystemLog } from "../../../../../../lib/apiLog";
import { getOwnSession, assembleParts, destroySession } from "../../../../../../lib/chunkedUploads";
import { processBundleUpload } from "../../../../../../lib/uploadPipeline";

export const dynamic = "force-dynamic";

export const POST = withSystemLog("/api/uploads/chunked/[id]/complete", async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  const upload = await getOwnSession((await ctx.params).id, access.userId);
  if (!upload) return Response.json({ error: "upload session not found" }, { status: 404 });

  const assembled = await assembleParts(upload);
  if ("error" in assembled) {
    // Incomplete — the client retries the missing part; do NOT destroy the session here.
    return Response.json({ error: assembled.error }, { status: assembled.status });
  }

  try {
    // maxBundleBytes is re-read at complete time, so lowering the limit mid-session still bites
    // (the pipeline 413s an over-limit assembly).
    const maxBytes = await getMaxBundleBytes();
    return await processBundleUpload({ ...access, userId: access.userId }, assembled.bytes, upload.filename, upload.skillSlug, maxBytes);
  } finally {
    // Whatever the outcome (201/413/422/503), the staging state is spent (§6).
    await destroySession(upload);
  }
});
