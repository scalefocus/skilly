// The consent screen's submit target (§29). The validated authorization request is held
// server-side under an opaque id, so this handler trusts nothing from the form except that id and
// the approve/deny decision — a hidden redirect_uri or client_id could otherwise be edited between
// render and submit.
//
// Every answer is an HTML page. Approve and Decline render the HAND-OFF page, which sends the
// browser on to the client — never a 303: browsers enforce CSP `form-action` across redirects, so a
// redirect from this form only survives if the consent screen's policy names the client's origin,
// and an edge proxy that replaces skilly's header silently breaks that (see lib/consentPages.ts).
// Every failure renders the consent error page, because this is a browser form target and a JSON
// body lands on a blank tab.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { resolveUserAccess } from "../../../lib/access";
import { getMcpEnabled } from "../../../lib/settings";
import { approveAuthorization, denyAuthorization, findClient, takeAuthorizeRequest } from "../../../lib/mcpOauth";
import {
  CONSENT_FAILURES,
  buildConsentErrorPage,
  buildHandoffPage,
  consentPageResponse,
  isSafeHandoffTarget,
  type ConsentFailure,
  type ConsentOutcome,
} from "../../../lib/consentPages";
import { recordFeatureUse } from "../../../lib/survey";
import { enforceRateLimit } from "../../../lib/ratelimit";

export const dynamic = "force-dynamic";

function fail(failure: ConsentFailure, headers?: Record<string, string>): Response {
  const { status, message } = CONSENT_FAILURES[failure];
  return consentPageResponse(buildConsentErrorPage(message), status, headers);
}

function handOff(clientName: string, target: string, outcome: ConsentOutcome): Response {
  return consentPageResponse(buildHandoffPage({ clientName, target, outcome }), 200);
}

export async function POST(req: Request) {
  if (!(await getMcpEnabled())) return fail("mcpDisabled");
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return fail("signedOut");
  const access = await resolveUserAccess(oid);
  if (!access.userId) return fail("notProvisioned");

  const limited = enforceRateLimit("oauth-consent", access.userId, 30);
  if (limited) return fail("rateLimited", { "retry-after": limited.headers.get("retry-after") ?? "60" });

  const form = await req.formData().catch(() => null);
  const requestId = String(form?.get("requestId") ?? "");
  const decision = String(form?.get("decision") ?? "");
  if (!requestId) return fail("incomplete");

  // Single-use, TTL'd, and bound to the user it was stashed for — an expired or foreign id fails
  // closed rather than authorizing something.
  const pending = await takeAuthorizeRequest(requestId, access.userId);
  if (!pending) return fail("expired");

  // Re-read the client at submit time: an admin may have blocked or removed it while the screen was
  // open. Checked for a decline too — the hand-off page names the client, and a blocked client is
  // not handed a browser either way.
  const client = await findClient(pending.clientId);
  if (!client) return fail("unknownClient");
  if (client.blocked) return fail("blockedClient");
  // A target registration would refuse (§49.5) is never rendered — and never earns a code.
  if (!isSafeHandoffTarget(pending.request.redirectUri)) return fail("unknownClient");

  if (decision !== "approve") {
    const { redirect } = denyAuthorization(pending.request);
    return handOff(client.clientName, redirect, "deny");
  }

  const { redirect } = await approveAuthorization(access.userId, client, pending.request);
  // §36.3 the MCP feature's first use. The browser leaves for the client right away, so nothing
  // could show a survey here: recorded with canShow = false (no roll), it feeds the fallback's pick.
  await recordFeatureUse(access.userId, "mcp", false).catch(() => null);
  return handOff(client.clientName, redirect, "approve");
}
