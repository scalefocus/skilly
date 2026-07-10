// Namespaces the signed-in user can file a skill into — suggestions for the propose form's
// namespace combobox. Visibility-scoped (global + the user's namespaces; all for platform
// admins). See lib/namespaces.ts.
import { currentAccess } from "../../../lib/guard";
import { listVisibleNamespaces } from "../../../lib/namespaces";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const namespaces = await listVisibleNamespaces(access);
  return Response.json({ namespaces });
}
