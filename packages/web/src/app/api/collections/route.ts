// Create a skill collection with its first member (SKILLY_SPEC.md §38.3 / §38.11).
// POST { name, skillId } → 201 { collection }; 409 collection_limit / name_taken; 422 invalid name or
// an ineligible skill. Any signed-in user.
import { createCollection } from "../../../lib/collections";
import { collectionCaller, collectionResponse, jsonBody } from "../../../lib/collectionsApi";
import { withSystemLog } from "../../../lib/apiLog";

export const dynamic = "force-dynamic";

export const POST = withSystemLog("/api/collections", async function POST(req: Request) {
  const caller = await collectionCaller({ write: true });
  if (caller instanceof Response) return caller;
  const body = await jsonBody(req);
  const r = await createCollection(caller.userId, body.name, body.skillId);
  return collectionResponse(r, 201, (collection) => ({ collection }));
});
