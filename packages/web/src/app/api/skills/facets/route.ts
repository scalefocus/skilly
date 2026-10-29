// Visibility-filtered facet counts for the catalog (categories + tools/harnesses), plus the
// caller's own *Updates available* count (§63.7).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { listFacets } from "../../../../lib/catalog";
import { upstreamCardUpdates } from "../../../../lib/upstreamReleases";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  // The shared counts are cached per visibility scope; the updates count is per caller, so it is
  // computed fresh and never enters that cache. `0` for everyone who owns no pending update.
  const [facets, updates] = await Promise.all([listFacets(access), upstreamCardUpdates(access, null)]);
  return Response.json({ ...facets, updates: updates.size });
}
