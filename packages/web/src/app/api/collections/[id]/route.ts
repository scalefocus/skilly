// One skill collection (SKILLY_SPEC.md §38.11).
//   GET    any signed-in user — name, description, owner, created date, eligible member count; 404 unknown.
//   PATCH  owner only — { name?, description? }; 409 name_taken, 422 invalid, 403 non-owner.
//   DELETE the owner or a platform admin — hard delete; audited when the actor is not the owner.
import { deleteCollection, getCollection, updateCollection } from "../../../../lib/collections";
import { collectionCaller, collectionResponse, jsonBody } from "../../../../lib/collectionsApi";
import { withSystemLog } from "../../../../lib/apiLog";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const caller = await collectionCaller();
  if (caller instanceof Response) return caller;
  const view = await getCollection((await ctx.params).id);
  if (!view) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({
    collection: view,
    isOwner: view.owner.id === caller.userId,
    canDelete: view.owner.id === caller.userId || caller.access.isPlatformAdmin,
  });
}

export const PATCH = withSystemLog("/api/collections/[id]", async function PATCH(req: Request, ctx: Ctx) {
  const caller = await collectionCaller({ write: true });
  if (caller instanceof Response) return caller;
  const body = await jsonBody(req);
  const r = await updateCollection(caller.userId, (await ctx.params).id, { name: body.name, description: body.description });
  return collectionResponse(r, 200, (v) => ({ collection: v }));
});

export const DELETE = withSystemLog("/api/collections/[id]", async function DELETE(_req: Request, ctx: Ctx) {
  const caller = await collectionCaller({ write: true });
  if (caller instanceof Response) return caller;
  return collectionResponse(await deleteCollection(caller.access, caller.userId, (await ctx.params).id));
});
