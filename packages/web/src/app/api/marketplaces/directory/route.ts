// The Marketplaces page's directory (SKILLY_SPEC.md §30.6 Page 3, §30.8): every plugin marketplace
// the caller may add. Any signed-in user. The row set itself is the visibility boundary — see
// lib/marketplaceDirectory.ts — so nothing here filters per row; it only resolves the caller.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { listMarketplaceDirectory } from "../../../../lib/marketplaceDirectory";
import { getMarketplaceNamePrefix, getMarketplacePublicEnabled, getPlatformSettings } from "../../../../lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ rows: [], syncMinutes: 30 });

  const [prefix, publicEnabled, settings] = await Promise.all([
    getMarketplaceNamePrefix(),
    getMarketplacePublicEnabled(),
    getPlatformSettings(),
  ]);
  const rows = await listMarketplaceDirectory(access, access.userId, prefix, publicEnabled);
  return Response.json({ rows, syncMinutes: settings.marketplaceSyncMinutes });
}
