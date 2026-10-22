// The What's new "Coming soon" list with votes (SKILLY_SPEC.md §60.3, §60.11).
// GET → { items, mine, limits }: the viewer's teasers plus every published idea, ordered by votes;
// the caller's own ideas; where they stand against the two caps. 404 while the feature is off.
import { getComingSoon } from "../../../lib/ideas";
import { ideasCaller } from "../../../lib/ideasRoute";

export const dynamic = "force-dynamic";

export async function GET() {
  const caller = await ideasCaller();
  if (!caller.ok) return caller.res;
  return Response.json(await getComingSoon(caller.viewer));
}
