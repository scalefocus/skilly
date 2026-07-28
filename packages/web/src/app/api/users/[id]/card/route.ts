// Directory hover card data for one user (SKILLY_SPEC.md §28).
// Any signed-in user may read any user's card: skilly has no per-user visibility model (invariant
// #7 is about skills), and everything returned is either already visible across the app (name,
// email, presence) or the Entra directory profile the feature exists to show. A user who opted out
// gets nulls for the three directory fields — they never reach another person's browser.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../lib/auth";
import { getUserCard } from "../../../../../lib/directory";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!(session as { oid?: string } | null)?.oid) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const card = await getUserCard((await ctx.params).id);
  if (!card) return Response.json({ error: "user not found" }, { status: 404 });
  return Response.json(card);
}
