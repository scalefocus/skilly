// §29: the caller's own live MCP connections — one row per client they have authorized. Powers the
// Connections list on /mcp. Read-only; revocation is the DELETE on [grantId].
import { currentAccess } from "../../../../lib/guard";
import { listConnections, publicBaseUrl } from "../../../../lib/mcpOauth";
import { getPlatformSettings } from "../../../../lib/settings";
import { pool } from "../../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const settings = await getPlatformSettings(pool);
  return Response.json({
    // The page still renders (and still lists connections to revoke) when MCP is switched off —
    // "off" is a kill-switch, not a purge (§29).
    enabled: settings.mcpEnabled,
    serverUrl: `${publicBaseUrl()}/mcp`,
    connections: await listConnections(access.userId),
  });
}
