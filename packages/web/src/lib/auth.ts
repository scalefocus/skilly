// OIDC SSO via Auth.js + Entra. Authentication ONLY.
// INVARIANT: do NOT read roles/groups from token claims — resolve them from the
// SCIM-synced group_memberships + role_mappings tables. SKILLY_SPEC.md §5, CLAUDE.md #1.
import type { NextAuthOptions } from "next-auth";
import AzureAD from "next-auth/providers/azure-ad";
import Credentials from "next-auth/providers/credentials";
import { pool } from "./db";
import { fetchEntraDirectoryProfile, saveDirectoryProfile } from "./directory";
import { resolveDevSignInOid } from "./devAuth";
import { syncSignInIdentity } from "./signInIdentity";

// DEV-ONLY: a credentials provider that signs in a seeded user without a password. Gated by
// SKILLY_DEV_AUTH=1 so it is NEVER present in production builds/runtime. Used for local visual/dev
// passes and the e2e suite without a real Entra tenant. The user's entra_object_id must exist in the
// seeded DB. With no `oid` it signs in SKILLY_DEV_OID (the dev admin); an `oid` may name only the dev
// admin or one of the e2e worker users (devAuth.ts — one per Playwright worker, §16 item 18).
// The hard fail-safe that forbids SKILLY_DEV_AUTH in production runs at server startup
// (instrumentation.ts register()), NOT here — a module-scope throw would also fire during
// `next build` (NODE_ENV=production).
const devProviders: NextAuthOptions["providers"] =
  process.env.SKILLY_DEV_AUTH === "1"
    ? [
        Credentials({
          id: "dev",
          name: "Dev sign-in",
          credentials: { oid: { label: "User", type: "text" } },
          async authorize(credentials) {
            const oid = resolveDevSignInOid(credentials?.oid, process.env.SKILLY_DEV_OID);
            if (!oid) return null;
            // The user row's own name/email (a worker user is not "Dev Admin"). Best-effort: the
            // session keys on the oid alone, so a lookup failure must not refuse the sign-in.
            const { rows } = await pool
              .query<{ display_name: string | null; email: string | null }>(
                `select display_name, email from users where entra_object_id = $1`,
                [oid],
              )
              .catch(() => ({ rows: [] as { display_name: string | null; email: string | null }[] }));
            return { id: oid, name: rows[0]?.display_name || "Dev Admin", email: rows[0]?.email || "dev@skilly.local" };
          },
        }),
      ]
    : [];

export const authOptions: NextAuthOptions = {
  providers: [
    AzureAD({
      clientId: process.env.ENTRA_CLIENT_ID ?? "",
      clientSecret: process.env.ENTRA_CLIENT_SECRET ?? "",
      tenantId: process.env.ENTRA_TENANT_ID ?? "",
      // Request basic profile + User.Read (so the provider can fetch the user's
      // Graph profile photo for the avatar, and the jwt callback below can refresh their
      // directory profile — §5/§28). Group/role resolution still happens
      // server-side via SCIM — NEVER from these claims (CLAUDE.md #1).
      authorization: { params: { scope: "openid profile email User.Read" } },
    }),
    ...devProviders,
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, profile, user, account }) {
      // Persist Entra object id so we can look up SCIM-synced access server-side.
      if (profile && "oid" in profile) token.oid = (profile as { oid?: string }).oid;
      // Dev credentials path: the fixed user's id IS the entra_object_id.
      // Only fall back to user.id when oid wasn't set from the OIDC profile above —
      // for Azure AD, profile.oid is the real Entra GUID; user.id is profile.sub.
      if (!token.oid && user?.id) token.oid = user.id;
      // Sign-in only (profile is present): sync display_name + email from Entra OIDC
      // claims. Handles users who logged in before reconciliation populated their profile,
      // or who aren't in any mapped group (reconcile skips them).
      // Only overwrites display_name when it is blank or was wrongly set to the raw OID.
      if (profile && token.oid) {
        const p = profile as { name?: string; email?: string; preferred_username?: string };
        // The identity step (self-heal relink of a mis-keyed row, then the blank-name backfill) is
        // ONE function shared with the agent sync API (§69.3), so both resolve a person the same
        // way. The relink is awaited inside it — access resolution keys on the oid right after
        // sign-in — and the cosmetic backfill is fire-and-forget. SKILLY_SPEC.md §5.
        await syncSignInIdentity({ oid: token.oid as string, name: p.name, email: p.email, preferredUsername: p.preferred_username });
      }
      // Sign-in only (user is present): persist the Entra profile photo the provider
      // fetched via Graph (small data URI) so maintainer bubbles can show it for OTHER
      // viewers. Fire-and-forget — sign-in must never block on this.
      const img = user?.image;
      if (img && token.oid && img.startsWith("data:image/") && img.length < 200_000) {
        void pool
          .query(`update users set avatar = $1 where entra_object_id = $2`, [img, token.oid])
          .catch(() => {});
      }
      // Sign-in only: refresh the user's OWN directory profile (job title / office / department)
      // from Graph with the delegated User.Read token we just received — the second of the two
      // writers in §5, and the only one that reaches users outside a role-mapped group. Overwrites
      // unconditionally (§28). Fire-and-forget: sign-in must never block on or fail with Graph.
      const accessToken = (account as { access_token?: string } | null | undefined)?.access_token;
      if (accessToken && token.oid) {
        const oid = token.oid as string;
        void fetchEntraDirectoryProfile(accessToken)
          .then((p) => (p ? saveDirectoryProfile(oid, p) : undefined))
          .catch(() => {});
      }
      return token;
    },
    async session({ session, token }) {
      (session as { oid?: string }).oid = token.oid as string | undefined;
      return session;
    },
  },
};
