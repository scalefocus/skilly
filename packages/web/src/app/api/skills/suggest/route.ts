// Header search autocomplete. Visibility-filtered like the catalog (#3). Hardened against
// DoS: auth-required, a tight per-user rate limit, a 2-char minimum (shorter → empty, no
// query runs), a length cap, and a small bounded result set (top 5; §10). Never an install path.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { suggestSkills } from "../../../../lib/catalog";
import { enforceRateLimit } from "../../../../lib/ratelimit";
import { pool } from "../../../../lib/db";

export const dynamic = "force-dynamic";

const MIN_CHARS = 2;
const MAX_CHARS = 64;

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const url = new URL(req.url);
  const raw = (url.searchParams.get("q") ?? "").trim();
  // scope=org (§26): the requested-skill "propose an existing skill" picker restricts results to
  // org-visible skills only, regardless of the searching user's own namespace access — so the
  // resulting fulfilment link is always openable by the requester and everyone else.
  const scope = url.searchParams.get("scope");
  const orgOnly = scope === "org";
  // scope=mention (§24 Mentions): a bare query suggests ORG-VISIBLE skills only; a query with a
  // `<ns>/` prefix the author can see into unlocks that namespace's restricted skills. Same rule
  // in every composer context.
  const mention = scope === "mention";
  // Enforce the floor BEFORE touching the DB (and before the rate-limit bucket) so a flood
  // of 1–2 char keystrokes costs nothing. (For mentions the floor applies to the whole query
  // after `#`, prefix included — per the spec.)
  if (raw.length < MIN_CHARS) return Response.json({ suggestions: [] });

  // Tight bucket — autocomplete is debounced client-side; this caps a scripted abuser.
  const limited = enforceRateLimit("suggest", oid, 40);
  if (limited) return limited;

  const access = await resolveUserAccess(oid);
  const q = raw.slice(0, MAX_CHARS);
  if (mention) {
    const slash = q.indexOf("/");
    if (slash > 0) {
      const prefix = q.slice(0, slash).toLowerCase();
      const rest = q.slice(slash + 1);
      // A valid namespace the author can see into? (Platform admins see every namespace.)
      const ns = await pool.query<{ id: string }>(`select id from namespaces where slug = $1`, [prefix]);
      const nsId = ns.rows[0]?.id;
      if (nsId && (access.isPlatformAdmin || access.namespaceRoles.has(nsId))) {
        return Response.json({ suggestions: await suggestSkills(access, rest, 6, { namespaceSlug: prefix }) });
      }
      // Not a namespace (or not theirs): fall through and treat the whole query as a bare name.
    }
    return Response.json({ suggestions: await suggestSkills(access, q, 6, { orgOnly: true }) });
  }
  const suggestions = await suggestSkills(access, q, 5, { orgOnly });
  return Response.json({ suggestions });
}
