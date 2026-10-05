// The header dropdown's Collections group (SKILLY_SPEC.md §38.6): the shared substring matcher over
// name, description and owner name; non-empty collections of active owners only; top 3; 2-char floor.
// Every member is org-visible, so the result is the same for every viewer.
import { COLLECTION_QUERY_MIN_CHARS } from "@skilly/shared/collections";
import { suggestCollections } from "../../../../lib/collections";
import { collectionCaller } from "../../../../lib/collectionsApi";
import { enforceRateLimit } from "../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

const MAX_CHARS = 64;

export async function GET(req: Request) {
  const caller = await collectionCaller();
  if (caller instanceof Response) return caller;
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < COLLECTION_QUERY_MIN_CHARS) return Response.json({ collections: [] });
  const limited = enforceRateLimit("collections-suggest", caller.userId, 40);
  if (limited) return limited;
  return Response.json({ collections: await suggestCollections(q.slice(0, MAX_CHARS)) });
}
