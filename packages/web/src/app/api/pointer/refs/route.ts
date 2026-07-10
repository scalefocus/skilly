// List a pointer repo's branches/tags so the propose form can warn when the pinned ref doesn't
// exist upstream (and offer the real ones). Any authenticated user (proposing is open); the URL
// is validated + SSRF-guarded in listRemoteRefs. Always 200 with an { ok } discriminator (except
// 401) so the form can render the warning without treating a bad URL as an HTTP error.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { enforceRateLimit } from "../../../../lib/ratelimit";
import { listRemoteRefs } from "../../../../lib/pointerRefs";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  // ls-remote is an outbound network call — rate-limit it per user.
  const limited = enforceRateLimit("pointer-refs", access.userId, 30);
  if (limited) return limited;

  const url = new URL(req.url).searchParams.get("url") ?? "";
  const result = await listRemoteRefs(url);
  return Response.json(result);
}
