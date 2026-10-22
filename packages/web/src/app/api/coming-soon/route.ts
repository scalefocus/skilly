// The What's new "Coming soon" list with votes (SKILLY_SPEC.md §60.3, §60.11).
// GET → { items, mine, limits, canSuggest }: every published item, ordered by votes; the caller's own
// ideas; where they stand against the two caps; whether they may suggest right now.
import { getComingSoon } from "../../../lib/ideas";
import { ideasCaller } from "../../../lib/ideasRoute";

export const dynamic = "force-dynamic";

export async function GET() {
  const caller = await ideasCaller();
  if (!caller.ok) return caller.res;
  return Response.json(await getComingSoon(caller.viewer));
}
