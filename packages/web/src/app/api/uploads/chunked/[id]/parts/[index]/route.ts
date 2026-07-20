// Chunked hosted-bundle upload — PART (§6). Raw application/octet-stream body (no multipart
// anywhere in the chunked flow); exact-size-enforced against the session's frozen chunk size;
// a re-PUT of the same index overwrites (retry-safe). NOT count-rate-limited — bounded by
// session ownership + exact byte accounting instead (§6).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../../lib/access";
import { withSystemLog } from "../../../../../../../lib/apiLog";
import { getOwnSession, putPart } from "../../../../../../../lib/chunkedUploads";

export const dynamic = "force-dynamic";

export const PUT = withSystemLog("/api/uploads/chunked/[id]/parts/[index]", async function PUT(req: Request, ctx: { params: Promise<{ id: string; index: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  const params = await ctx.params;
  const upload = await getOwnSession(params.id, access.userId);
  if (!upload) return Response.json({ error: "upload session not found" }, { status: 404 });

  const index = Number(params.index);
  if (!Number.isInteger(index) || index < 0) return Response.json({ error: "invalid part index" }, { status: 422 });

  // Refuse an over-declared body before buffering it (the exact-size check runs after reading).
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > upload.chunkBytes) {
    return Response.json({ error: `a part may not exceed the chunk size of ${upload.chunkBytes} bytes` }, { status: 413 });
  }

  const body = Buffer.from(await req.arrayBuffer());
  const result = await putPart(upload, index, body);
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true });
});
