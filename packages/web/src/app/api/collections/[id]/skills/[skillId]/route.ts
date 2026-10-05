// Collection membership (SKILLY_SPEC.md §37.3 / §37.11). Owner only, both idempotent.
//   PUT    add — 422 for an ineligible skill (not org-visible, archived, or nothing installable),
//          409 collection_full at 50 skills.
//   DELETE remove — the popup's untick and the catalog card's ✕.
import { addSkillToCollection, removeSkillFromCollection } from "../../../../../../lib/collections";
import { collectionCaller, collectionResponse } from "../../../../../../lib/collectionsApi";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; skillId: string }> };

export async function PUT(_req: Request, ctx: Ctx) {
  const caller = await collectionCaller({ write: true });
  if (caller instanceof Response) return caller;
  const { id, skillId } = await ctx.params;
  return collectionResponse(await addSkillToCollection(caller.userId, id, skillId));
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const caller = await collectionCaller({ write: true });
  if (caller instanceof Response) return caller;
  const { id, skillId } = await ctx.params;
  return collectionResponse(await removeSkillFromCollection(caller.userId, id, skillId));
}
