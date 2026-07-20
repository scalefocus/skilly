// Chunked hosted-bundle upload — START (§6). Opens a staging session for a bundle larger than
// the configured chunk size, after sweeping every orphaned session older than 2 h. Returns the
// server-authoritative chunk size the client must slice by.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { enforceRateLimit } from "../../../../lib/ratelimit";
import { getPlatformSettings } from "../../../../lib/settings";
import { pool } from "../../../../lib/db";
import { withSystemLog } from "../../../../lib/apiLog";
import { sweepStaleSessions, createSession } from "../../../../lib/chunkedUploads";

export const dynamic = "force-dynamic";

export const POST = withSystemLog("/api/uploads/chunked", async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  // Same bucket as the single-shot upload — a chunked start IS an upload attempt.
  const limited = enforceRateLimit("uploads", access.userId, 20);
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as { skillSlug?: unknown; filename?: unknown; totalBytes?: unknown };
  const skillSlug = typeof body.skillSlug === "string" ? body.skillSlug.trim() : "";
  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  const totalBytes = typeof body.totalBytes === "number" ? body.totalBytes : NaN;

  // Sweep orphans BEFORE opening the new session (§6) — best-effort, never blocks the upload.
  try {
    await sweepStaleSessions();
  } catch (e) {
    console.error(JSON.stringify({ level: "warn", msg: "staging sweep failed (non-fatal)", err: String(e) }));
  }

  const settings = await getPlatformSettings(pool);
  const result = await createSession(
    access.userId,
    { skillSlug, filename, totalBytes },
    { maxBundleBytes: settings.maxBundleBytes, chunkBytes: settings.uploadChunkBytes },
  );
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ uploadId: result.session.id, chunkBytes: result.session.chunkBytes }, { status: 201 });
});
