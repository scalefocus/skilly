// Live slug lookup for the propose form (SKILLY_SPEC.md §8 slug match): every ACTIVE skill with this
// slug, in any namespace, that the CALLER can see — so the form can switch a new-skill proposal into
// the new-version flow before submit. Visibility-filtered through the shared predicate (invariant
// #3): a hidden skill is never returned, counted or hinted at. Read-only; the proposals/publish
// endpoints re-check authoritatively.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { findSlugMatches, publicMatch } from "../../../../lib/duplicate";
import { enforceRateLimit } from "../../../../lib/ratelimit";
import { normalizeMatchSlug } from "@skilly/shared";

export const dynamic = "force-dynamic";

/** Slugs are kebab-case and at most 63 chars (§6); anything longer can't match. */
const MAX_SLUG = 64;

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const slug = normalizeMatchSlug(new URL(req.url).searchParams.get("slug"));
  if (!slug || slug.length > MAX_SLUG) return Response.json({ matches: [] });

  // Debounced client-side; this caps a scripted caller.
  const limited = enforceRateLimit("slug-matches", oid, 60);
  if (limited) return limited;

  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const matches = await findSlugMatches(access, slug);
  return Response.json({ matches: matches.map(publicMatch) });
}
