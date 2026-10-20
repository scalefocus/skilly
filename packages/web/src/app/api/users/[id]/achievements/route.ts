// The achievements hall payload for one user (SKILLY_SPEC.md §31.8). Any signed-in user may read
// any active user's earned badges — unless that user opted out, in which case a non-self viewer
// gets `hidden: true` and an empty list. 404 for unknown / erased / inactive; `{ disabled: true }`
// (200) while the platform toggle is off, mirroring the /api/mcp pattern.
import { currentAccess } from "../../../../../lib/guard";
import { getAchievements } from "../../../../../lib/achievements";
import { getAchievementsEnabled } from "../../../../../lib/settings";
import { achievementFlagsFor } from "../../../../../lib/achievementFlags";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!(await getAchievementsEnabled())) return Response.json({ disabled: true });
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return Response.json({ error: "user not found" }, { status: 404 });
  // §31.12.4: the switch state matters only for the owner's own locked tiles.
  const flags = id.toLowerCase() === access.userId.toLowerCase() ? await achievementFlagsFor(access) : undefined;
  const view = await getAchievements(id, access.userId, undefined, flags);
  if (!view) return Response.json({ error: "user not found" }, { status: 404 });
  return Response.json(view);
}
