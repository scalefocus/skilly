// Namespaces a restricted skill may be shared with (SKILLY_SPEC.md §42.3) — the "Share with
// namespaces" picker on the propose form, the review page and the detail page's Shared with card.
// Any signed-in user; all namespaces except `global`, with ids.
import { currentAccess } from "../../../../lib/guard";
import { listShareTargets } from "../../../../lib/namespaces";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  return Response.json({ namespaces: await listShareTargets() });
}
