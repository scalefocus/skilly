// §29 Administration → MCP server: status for the admin card. Platform admin only.
import { currentAccess } from "../../../../lib/guard";
import { adminMcpStatus, publicBaseUrl } from "../../../../lib/mcpOauth";
import { getPlatformSettings } from "../../../../lib/settings";
import { pool } from "../../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access?.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const [settings, status] = await Promise.all([getPlatformSettings(pool), adminMcpStatus()]);
  return Response.json({
    enabled: settings.mcpEnabled,
    accessTtlMinutes: settings.mcpAccessTtlMinutes,
    refreshTtlDays: settings.mcpRefreshTtlDays,
    maxInlineUploadBytes: settings.mcpMaxInlineUploadBytes,
    maxResourceBytes: settings.mcpMaxResourceBytes,
    serverUrl: `${publicBaseUrl()}/mcp`,
    ...status,
  });
}
