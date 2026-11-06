// The homepage "Popular in your department" row (SKILLY_SPEC.md §66.7): up to six skills colleagues
// in the viewer's Entra department first adopted in the last 90 days, each with its colleague count
// (never who). Visibility-filtered, the viewer's own adoptions left out. Switch off or no department
// ⇒ `department: null` and no skills — never a 404, so the Overview section simply hides itself.
// A read: not audited, not logged.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { departmentPopular } from "../../../../lib/departmentPopular";
import { enforceRateLimit } from "../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("department-popular", oid, 120);
  if (limited) return limited;
  const access = await resolveUserAccess(oid);
  return Response.json(await departmentPopular(access));
}
