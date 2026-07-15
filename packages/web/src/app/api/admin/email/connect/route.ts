// Platform-admin: start the "Set email service account" OAuth flow (§12) — a standard
// authorization-code redirect against the existing skilly Entra app registration with
// delegated Mail.Send + offline_access, PKCE, and a state cookie bound to this browser.
// prompt=select_account so the admin signs in AS the service mailbox instead of silently
// reusing their own SSO session. This is NOT a sign-in: no skilly session, no roles (§5).
import { randomBytes } from "node:crypto";
import { currentAccess } from "../../../../../lib/guard";
import { EMAIL_OAUTH_STATE_COOKIE as STATE_COOKIE, EMAIL_OAUTH_VERIFIER_COOKIE as VERIFIER_COOKIE, webBaseUrl, webGraphMailEnv } from "../../../../../lib/email";
import { buildAuthorizeUrl, createPkcePair } from "@skilly/shared/email";

export const dynamic = "force-dynamic";

function cookie(name: string, value: string, req: Request, maxAgeSec: number): string {
  const secure = new URL(req.url).protocol === "https:" || webBaseUrl().startsWith("https:");
  return `${name}=${value}; Path=/api/admin/email; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access?.userId || !access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const env = webGraphMailEnv();
  if (!env) {
    return Response.json({ error: "EMAIL_TOKEN_ENC_KEY, ENTRA_EMAIL_CLIENT_ID, or ENTRA_EMAIL_CLIENT_SECRET is not configured — the connect flow is disabled" }, { status: 422 });
  }

  const state = randomBytes(24).toString("base64url");
  const { verifier, challenge } = createPkcePair();
  const redirectUri = `${webBaseUrl() || new URL(req.url).origin}/api/admin/email/callback`;
  const url = buildAuthorizeUrl(env, { redirectUri, state, codeChallenge: challenge });

  const headers = new Headers({ Location: url });
  headers.append("set-cookie", cookie(STATE_COOKIE, state, req, 600));
  headers.append("set-cookie", cookie(VERIFIER_COOKIE, verifier, req, 600));
  return new Response(null, { status: 302, headers });
}
