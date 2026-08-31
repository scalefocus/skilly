// The consent screen's submit target (§29). The validated authorization request is held
// server-side under an opaque id, so this handler trusts nothing from the form except that id and
// the approve/deny decision — a hidden redirect_uri or client_id could otherwise be edited between
// render and submit.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { resolveUserAccess } from "../../../lib/access";
import { getMcpEnabled } from "../../../lib/settings";
import { approveAuthorization, denyAuthorization, findClient, takeAuthorizeRequest } from "../../../lib/mcpOauth";
import { enforceRateLimit } from "../../../lib/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!(await getMcpEnabled())) {
    return Response.json({ error: "MCP is disabled on this registry" }, { status: 503 });
  }
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  const limited = enforceRateLimit("oauth-consent", access.userId, 30);
  if (limited) return limited;

  const form = await req.formData().catch(() => null);
  const requestId = String(form?.get("requestId") ?? "");
  const decision = String(form?.get("decision") ?? "");
  if (!requestId) return Response.json({ error: "missing requestId" }, { status: 400 });

  // Single-use, TTL'd, and bound to the user it was stashed for — an expired or foreign id fails
  // closed rather than authorizing something.
  const pending = takeAuthorizeRequest(requestId, access.userId);
  if (!pending) {
    return Response.json(
      { error: "this consent request expired or was already used — start the connection again from your client" },
      { status: 400 },
    );
  }

  if (decision !== "approve") {
    const { redirect } = denyAuthorization(pending.request);
    return Response.redirect(redirect, 303);
  }

  // Re-read the client at submit time: an admin may have blocked it while the screen was open.
  const client = await findClient(pending.clientId);
  if (!client) return Response.json({ error: "unknown client" }, { status: 400 });
  if (client.blocked) return Response.json({ error: "this client has been blocked by an administrator" }, { status: 403 });

  const { redirect } = await approveAuthorization(access.userId, client, pending.request);
  return Response.redirect(redirect, 303);
}
