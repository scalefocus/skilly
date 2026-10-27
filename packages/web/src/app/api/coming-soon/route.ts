// The What's new "Coming soon" list with votes (SKILLY_SPEC.md §60.3, §60.11).
// GET → { items, mine, limits, canSuggest, votesHidden }: every published item, ordered by votes,
// with its "Upvoted by" strip; the caller's own ideas; where they stand against the two caps; whether
// they may suggest right now; whether they hide their own bubble. The open list polls this every
// 15 s, so it carries a weak ETag and answers 304 when the caller's `If-None-Match` still matches.
import { getComingSoon } from "../../../lib/ideas";
import { ideasCaller } from "../../../lib/ideasRoute";
import { conditionalJson } from "../../../lib/etag";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const caller = await ideasCaller();
  if (!caller.ok) return caller.res;
  return conditionalJson(req, await getComingSoon(caller.viewer));
}
