// §29 Dynamic Client Registration (RFC 7591). OPEN by design: a client_id grants nothing until a
// human completes the Entra login + consent leg at /oauth/authorize, so consent — not an admin
// allowlist — is the gate. Growth is bounded by this route's per-IP rate limit, the worker's 7-day
// prune of never-used registrations, and the admin block list (§22).
//
// Unauthenticated on purpose: an MCP client registers BEFORE it has any user context.
import { getMcpEnabled } from "../../../lib/settings";
import { registerClient, publicBaseUrl } from "../../../lib/mcpOauth";
import { enforceRateLimit } from "../../../lib/ratelimit";
import { MCP_SCOPE } from "@skilly/shared";

export const dynamic = "force-dynamic";

/** Best-effort client IP for the rate-limit key and the registration record. */
function clientKey(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  return (xff ? xff.split(",")[0]!.trim() : null) ?? req.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(req: Request) {
  if (!(await getMcpEnabled())) {
    return Response.json({ error: "temporarily_unavailable", error_description: "MCP is disabled on this registry" }, { status: 503 });
  }
  // Per-IP, not per-user: there is no user yet. 10/min is generous for a real client (which
  // registers once and caches its client_id) and useless for filling the table.
  const ip = clientKey(req);
  const limited = enforceRateLimit("oauth-register", ip, 10);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "invalid_client_metadata", error_description: "expected a JSON object" }, { status: 400 });
  }

  const result = await registerClient(body, ip === "unknown" ? null : ip);
  if (!result.ok) {
    return Response.json({ error: "invalid_client_metadata", error_description: result.error }, { status: 400 });
  }
  const c = result.client;
  // RFC 7591 §3.2.1 — 201 with the registered metadata echoed back. No client_secret: skilly
  // issues public clients only (an MCP CLI/desktop client can't keep one), with PKCE as the
  // compensating control.
  return Response.json(
    {
      client_id: c.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: c.clientName,
      client_uri: c.clientUri ?? undefined,
      logo_uri: c.logoUri ?? undefined,
      redirect_uris: c.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: MCP_SCOPE,
      authorization_endpoint: `${publicBaseUrl()}/oauth/authorize`,
      token_endpoint: `${publicBaseUrl()}/oauth/token`,
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

/** A GET here is a common misconfiguration; answer with something actionable. */
export async function GET() {
  return Response.json(
    { error: "invalid_request", error_description: "POST client metadata here to register (RFC 7591)" },
    { status: 405 },
  );
}
