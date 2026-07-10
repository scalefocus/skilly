// Known category labels — suggestions for the propose form's category combobox. Categories
// are non-sensitive labels (not skills), so the full list is fine for any authenticated user.
import { currentAccess } from "../../../lib/guard";
import { listAllCategories } from "../../../lib/catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  return Response.json({ categories: await listAllCategories() });
}
