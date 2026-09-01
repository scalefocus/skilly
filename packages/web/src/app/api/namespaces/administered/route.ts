// Namespaces the caller administers, with their settings — the Namespace administration page
// (SKILLY_SPEC.md §30.6). Platform admins see every namespace; namespace admins see their own;
// anyone else gets 403 (and never sees the nav entry).
import { currentAccess } from "../../../../lib/guard";
import { administersAnyNamespace, listAdministeredNamespaces } from "../../../../lib/namespaceAdmin";
import { getMarketplaceNamePrefix } from "../../../../lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!administersAnyNamespace(access)) return Response.json({ error: "namespace admin required" }, { status: 403 });

  const prefix = await getMarketplaceNamePrefix();
  return Response.json({
    namespaces: await listAdministeredNamespaces(access, prefix),
    isPlatformAdmin: access.isPlatformAdmin,
  });
}
