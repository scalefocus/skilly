// The caller's own "People I follow" list (SKILLY_SPEC.md §35.5 / §35.10) — newest first, with each
// person's state (active / paused / inactive). Also the page-wide source of truth for every
// FollowButton's Follow ↔ Unfollow label (§35.4).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { listFollowing } from "../../../../lib/follows";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ following: [] });
  return Response.json({ following: await listFollowing(access.userId) });
}
