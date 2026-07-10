// Sign-out cleanup: delete EVERY auth cookie skilly set, so nothing lingers in the browser after
// logout. next-auth's signOut() clears the session token + callback-url, but leaves the CSRF token
// (and any abandoned transient OAuth cookies — pkce/state/nonce), all of which are httpOnly and so
// can't be removed by client JS. We enumerate the request's cookies and expire any whose name is an
// auth cookie (covers the __Secure-/__Host- prefixed variants by matching the actual names present).
// Called by the AppShell sign-out handler AFTER signOut() (which needs the CSRF cookie to run).
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

const AUTH_COOKIE = /(next-auth|authjs)/i;

export async function POST() {
  const store = await cookies();
  for (const c of store.getAll()) {
    if (AUTH_COOKIE.test(c.name)) store.delete(c.name);
  }
  return new Response(null, { status: 204 });
}
