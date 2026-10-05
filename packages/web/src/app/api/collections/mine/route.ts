// The caller's own collections (SKILLY_SPEC.md §38.7 / §38.11), newest first, with eligible member
// counts. `?skillId=` adds `contains` + `itemCount` per row for the Add-to-collection popup (§38.3).
import { listMyCollections } from "../../../../lib/collections";
import { collectionCaller } from "../../../../lib/collectionsApi";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const caller = await collectionCaller();
  if (caller instanceof Response) return caller;
  const skillId = new URL(req.url).searchParams.get("skillId");
  return Response.json({ collections: await listMyCollections(caller.userId, skillId) });
}
