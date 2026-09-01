// The caller's added Claude plugin marketplaces (SKILLY_SPEC.md §30.6). The marketplace analogue
// of /api/installs — owner-scoped, lists USED tokens only. Minting lives at
// POST /api/marketplaces/tokens (§30.8).
import { getServerSession } from "next-auth";
import { PUBLIC_SCOPE, marketplaceName } from "@skilly/shared";
import { authOptions } from "../../../lib/auth";
import { resolveUserAccess } from "../../../lib/access";
import { listMarketplaces } from "../../../lib/marketplaces";
import { getMarketplaceNamePrefix, getMarketplacePublicEnabled } from "../../../lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ marketplaces: [] });

  const prefix = await getMarketplaceNamePrefix();
  const [marketplaces, publicEnabled] = await Promise.all([
    listMarketplaces(access.userId, prefix),
    getMarketplacePublicEnabled(),
  ]);
  // The public marketplace is open to every authenticated user, so the page offers it directly —
  // there is no admin surface a regular consumer could otherwise reach to add it (§30.4).
  return Response.json({
    marketplaces,
    publicMarketplace: { enabled: publicEnabled, name: marketplaceName(prefix, PUBLIC_SCOPE) },
  });
}
