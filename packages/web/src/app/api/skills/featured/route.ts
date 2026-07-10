// The homepage "Featured skills" feed (§7): platform-admin-pinned skills, visibility-filtered per
// viewer (invariant #3), installable-only, most-recent-featured first. Auth-required like the rest
// of the catalog; an empty list ⇒ the Overview section hides itself.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { listFeaturedSkills } from "../../../../lib/catalog";
import { enforceRateLimit } from "../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("featured", oid, 120);
  if (limited) return limited;
  const access = await resolveUserAccess(oid);
  const skills = await listFeaturedSkills(access);
  return Response.json({ skills });
}
