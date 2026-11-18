// `/verify` lookup (SKILLY_SPEC.md §73.10): which versions THE CALLER CAN SEE have exactly these
// files, by the installer-compatible computedHash. A hidden skill never matches (invariant #3).
//   POST /api/verify/lookup  { hashes: string[] }  (≤ 200)  ->  { results: [{ computedHash, matches[] }] }
import { currentAccess } from "../../../../lib/guard";
import { enforceRateLimit } from "../../../../lib/ratelimit";
import { lookupHashes, parseLookupHashes } from "../../../../lib/signing";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  // Rate-limited like search (§34): it answers "is there a skill with these files?".
  const limited = enforceRateLimit("verify_lookup", access.userId, 60);
  if (limited) return limited;
  const hashes = parseLookupHashes(await req.json().catch(() => null));
  if (typeof hashes === "string") return Response.json({ error: hashes }, { status: 422 });
  return Response.json({ results: await lookupHashes(access, hashes) });
}
