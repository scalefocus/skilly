// Chunked hosted-bundle upload — ABORT (§6). Owner-checked; deletes the session row + every
// staged part. The upload UI calls it best-effort when the user removes/replaces a staged file
// mid-upload; an abandoned session is otherwise collected by the 2 h sweep.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../lib/access";
import { withSystemLog } from "../../../../../lib/apiLog";
import { getOwnSession, destroySession } from "../../../../../lib/chunkedUploads";

export const dynamic = "force-dynamic";

export const DELETE = withSystemLog("/api/uploads/chunked/[id]", async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  const upload = await getOwnSession((await ctx.params).id, access.userId);
  // Missing and not-yours are indistinguishable on purpose; deleting a gone session is success.
  if (!upload) return Response.json({ ok: true });
  await destroySession(upload);
  return Response.json({ ok: true });
});
