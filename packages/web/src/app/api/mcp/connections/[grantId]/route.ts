// §29: revoke ONE of the caller's own MCP connections. Immediate — the grant and every token under
// it stop working on the next request, not at expiry. Audited (`mcp.grant_revoked`).
//
// This deliberately does NOT touch install tokens the client minted: those are ordinary §23
// installations that outlive the connection and are revoked from /installed by uninstalling.
import { currentAccess } from "../../../../../lib/guard";
import { revokeConnection } from "../../../../../lib/mcpOauth";
import { enforceRateLimit } from "../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ grantId: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("mcp-revoke", access.userId, 30);
  if (limited) return limited;
  const { grantId } = await ctx.params;
  const done = await revokeConnection(access.userId, grantId, access.userId);
  return done
    ? Response.json({ ok: true })
    : Response.json({ error: "no such connection of yours" }, { status: 404 });
}
