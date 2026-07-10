// OIDC SSO via Auth.js + Entra. Authentication ONLY.
// INVARIANT: do NOT read roles/groups from token claims — resolve them from the
// SCIM-synced group_memberships + role_mappings tables. SKILLY_SPEC.md §5, CLAUDE.md #1.
import type { NextAuthOptions } from "next-auth";
import AzureAD from "next-auth/providers/azure-ad";
import Credentials from "next-auth/providers/credentials";
import { pool } from "./db";

// DEV-ONLY: a credentials provider that signs in a fixed user. Gated by SKILLY_DEV_AUTH=1
// so it is NEVER present in production builds/runtime. Used for local visual/dev passes
// without a real Entra tenant. The user's entra_object_id must exist in the seeded DB.
// Dev passwordless sign-in is gated by SKILLY_DEV_AUTH=1. The hard fail-safe that forbids it
// in production runs at server startup (instrumentation.ts register()), NOT here — a
// module-scope throw would also fire during `next build` (NODE_ENV=production).
const devProviders: NextAuthOptions["providers"] =
  process.env.SKILLY_DEV_AUTH === "1"
    ? [
        Credentials({
          id: "dev",
          name: "Dev sign-in",
          credentials: {},
          async authorize() {
            return { id: process.env.SKILLY_DEV_OID ?? "dev-oid", name: "Dev Admin", email: "dev@skilly.local" };
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
      // Graph profile photo for the avatar). Group/role resolution still happens
      // server-side via SCIM — NEVER from these claims (CLAUDE.md #1).
      authorization: { params: { scope: "openid profile email User.Read" } },
    }),
    ...devProviders,
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, profile, user }) {
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
        const name = p.name ?? "";
        const email = p.email ?? p.preferred_username ?? "";
        // Self-heal a mis-keyed identity BEFORE the profile sync below (which matches on
        // entra_object_id = oid). skilly keys users on entra_object_id = the OIDC `oid` (the Entra
        // directory objectId GUID), but SCIM provisioning sets entra_object_id from the SCIM
        // `externalId` — whose Entra DEFAULT attribute mapping is `mailNickname`, NOT the objectId.
        // A row provisioned that way is keyed on the wrong id and can NEVER be found at login. When
        // no row owns this oid yet, relink the row found by the authenticated user's email/UPN to
        // this oid. Idempotent (skipped once a row owns the oid), erased users excluded, at most one
        // row relinked. Within a single Entra tenant emails/UPNs are unique, so the match identifies
        // exactly one person. AWAITED (unlike the cosmetic syncs) because access resolution keys on
        // the oid right after sign-in. SKILLY_SPEC.md §5.
        const emails = [...new Set([p.email, p.preferred_username].filter((s): s is string => !!s).map((s) => s.toLowerCase()))];
        if (emails.length) {
          try {
            await pool.query(
              `UPDATE users SET entra_object_id = $1, updated_at = now()
                 WHERE id = (SELECT id FROM users
                              WHERE lower(email) = ANY($2::text[]) AND entra_object_id <> $1
                                AND erased_at IS NULL
                              ORDER BY created_at ASC LIMIT 1)
                   AND NOT EXISTS (SELECT 1 FROM users WHERE entra_object_id = $1)`,
              [token.oid, emails],
            );
          } catch { /* non-fatal: correctly-keyed rows already match by oid */ }
        }
        if (name) {
          void pool
            .query(
              `UPDATE users
               SET display_name = $1,
                   email = CASE WHEN (email IS NULL OR email = '') THEN $2 ELSE email END
               WHERE entra_object_id = $3
                 AND (display_name IS NULL OR display_name = '' OR display_name = $3)`,
              [name, email, token.oid],
            )
            .catch(() => {});
        }
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
      return token;
    },
    async session({ session, token }) {
      (session as { oid?: string }).oid = token.oid as string | undefined;
      return session;
    },
  },
};
