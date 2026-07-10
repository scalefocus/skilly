// NextAuth (Auth.js) handler — OIDC SSO via Entra. SKILLY_SPEC.md §5.
import NextAuth from "next-auth";
import { authOptions } from "../../../../lib/auth";

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
