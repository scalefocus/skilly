// Platform-admin: complete the §12 connect flow. Guarded by the INITIATING admin's session
// + the state cookie + PKCE; exchanges the code, stores the account identity + encrypted
// tokens (atomic replace), audits `email.account_connected` (with the replaced UPN — never
// tokens), then returns to the Administration page. Errors land back on /admin as a query
// param the Email notifications card displays.
import { currentAccess } from "../../../../../lib/guard";
import { EMAIL_OAUTH_STATE_COOKIE as STATE_COOKIE, EMAIL_OAUTH_VERIFIER_COOKIE as VERIFIER_COOKIE, finishConnect, webBaseUrl, webGraphMailEnv } from "../../../../../lib/email";
import { exchangeAuthCode, parseIdTokenClaims } from "@skilly/shared/email";

export const dynamic = "force-dynamic";

function readCookie(req: Request, name: string): string | null {
  const jar = req.headers.get("cookie") ?? "";
  for (const part of jar.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function backToAdmin(req: Request, error?: string): Response {
  const base = webBaseUrl() || new URL(req.url).origin;
  const headers = new Headers({ Location: `${base}/admin${error ? `?emailError=${encodeURIComponent(error)}` : "?email=connected"}` });
  // One-shot cookies — clear them either way.
  for (const name of [STATE_COOKIE, VERIFIER_COOKIE]) {
    headers.append("set-cookie", `${name}=; Path=/api/admin/email; HttpOnly; SameSite=Lax; Max-Age=0`);
  }
  return new Response(null, { status: 302, headers });
}

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access?.userId || !access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const env = webGraphMailEnv();
  if (!env) return backToAdmin(req, "EMAIL_TOKEN_ENC_KEY is not configured");

  const url = new URL(req.url);
  const entraError = url.searchParams.get("error");
  if (entraError) return backToAdmin(req, `${entraError}: ${url.searchParams.get("error_description") ?? ""}`.slice(0, 300));

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = readCookie(req, STATE_COOKIE);
  const verifier = readCookie(req, VERIFIER_COOKIE);
  if (!code || !state || !expectedState || state !== expectedState || !verifier) {
    return backToAdmin(req, "the sign-in attempt could not be verified (state mismatch) — try again");
  }

  try {
    const redirectUri = `${webBaseUrl() || url.origin}/api/admin/email/callback`;
    const tokens = await exchangeAuthCode(env, { code, redirectUri, codeVerifier: verifier });
    const claims = parseIdTokenClaims(tokens.idToken);
    await finishConnect(env, { claims, tokens, actorUserId: access.userId });
    return backToAdmin(req);
  } catch (err) {
    return backToAdmin(req, String((err as Error).message ?? err).slice(0, 300));
  }
}
