// Visibility-filtered catalog search. SKILLY_SPEC.md §10 (auth-required, strictly filtered).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { resolveUserAccess } from "../../../lib/access";
import { searchSkills } from "../../../lib/catalog";
import { getNavSeen } from "../../../lib/settings";
import { enforceRateLimit } from "../../../lib/ratelimit";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The `?maintainer=` user id, only if it's a well-formed UUID (else ignored — never errors the query). */
function maintainerParam(url: URL): string | undefined {
  const m = url.searchParams.get("maintainer");
  return m && UUID_RE.test(m) ? m : undefined;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("search", oid, 120);
  if (limited) return limited;
  const access = await resolveUserAccess(oid);

  const url = new URL(req.url);
  const archivedOnly = url.searchParams.get("archived") === "1";
  // Per-row "new to you" flag: skills created after the caller last opened the catalog (matches
  // the nav "new items" count). Not meaningful for the archived owner-view, so skip it there.
  // The timestamp is advanced on LEAVE (see AppShell), so it stays stable across in-visit
  // filtering/sorting. §10.
  const catalogSeenAt = !archivedOnly && access.userId ? (await getNavSeen(access.userId)).catalogSeenAt : null;
  const skills = await searchSkills(access, {
    q: url.searchParams.get("q") ?? undefined,
    category: url.searchParams.get("category") ?? undefined,
    tool: url.searchParams.get("tool") ?? undefined,
    type: url.searchParams.get("type") === "hosted" ? "hosted" : url.searchParams.get("type") === "pointer" ? "pointer" : undefined,
    sort: url.searchParams.get("sort") === "top_rated" ? "top_rated" : url.searchParams.get("sort") === "latest" ? "latest" : undefined,
    // `?archived=1` flips to showing ONLY archived skills, owner-scoped in the query (a
    // non-owner gets none). The UI only shows the toggle to managers.
    archivedOnly,
    // "Official only" facet (§7): platform-endorsed skills. Visibility still enforced in searchSkills.
    officialOnly: url.searchParams.get("official") === "1",
    ownerUserId: access.userId,
    // Explicit-maintainer filter (§19): `?mine=1` → the caller (the "My Skills" facet); `?maintainer=<uuid>`
    // → an arbitrary person (the leaderboard "Skills" action, §21). Visibility is still enforced in
    // searchSkills, so this never reveals a skill the viewer couldn't already see (invariant #3). The
    // maintainer value is UUID-validated so a malformed id is ignored rather than erroring the query.
    maintainerUserId: maintainerParam(url) ?? (url.searchParams.get("mine") === "1" ? access.userId : undefined),
    catalogSeenAt,
  });
  return Response.json({ skills });
}
