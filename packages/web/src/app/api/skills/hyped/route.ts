// The homepage "Hyped skills" feed (SKILLY_SPEC.md §50.6): the current top N as of the last sweep,
// in board order, visibility-filtered like every home feed. Empty (or the feature off) ⇒ the
// Overview section hides itself.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { listHypedSkills } from "../../../../lib/catalog";
import { enforceRateLimit } from "../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("hyped", oid, 120);
  if (limited) return limited;
  const access = await resolveUserAccess(oid);
  return Response.json({ skills: await listHypedSkills(access) });
}
