// The sign-in identity step (SKILLY_SPEC.md §5 "Identity key"), shared by the two places an Entra
// identity arrives: the Auth.js `jwt` callback (web sign-in) and the agent sync API (§69.3). ONE
// implementation, so a person resolves to the same skilly user from the browser and from an agent.
//
// skilly keys users on `entra_object_id` = the Entra directory objectId (the `oid` claim). This step
// never creates a user and never reads roles or groups (invariant #1) — it only:
//   1. self-heals a row that SCIM provisioned under a wrong `externalId`, and
//   2. backfills a blank display name.
import { pool } from "./db";

export interface SignInClaims {
  /** The Entra directory objectId — the `oid` claim. */
  oid: string;
  name?: string | null;
  email?: string | null;
  preferredUsername?: string | null;
}

type Db = { query(text: string, params?: unknown[]): Promise<unknown> };

/** The lower-cased, de-duplicated email/UPN candidates a relink may match on. */
export function signInEmails(c: Pick<SignInClaims, "email" | "preferredUsername">): string[] {
  return [...new Set([c.email, c.preferredUsername].filter((s): s is string => !!s).map((s) => s.toLowerCase()))];
}

/**
 * Self-heal a mis-keyed identity. SCIM provisioning sets `entra_object_id` from the SCIM
 * `externalId`, whose Entra DEFAULT attribute mapping is `mailNickname`, NOT the objectId. A row
 * provisioned that way is keyed on the wrong id and can never be found by `oid`. When no row owns
 * this oid yet, relink the row found by the authenticated user's email/UPN to it. Idempotent
 * (skipped once a row owns the oid), erased users excluded, at most one row relinked. Within a
 * single Entra tenant emails/UPNs are unique, so the match identifies exactly one person.
 */
export async function relinkIdentityByEmail(db: Db, oid: string, emails: string[]): Promise<void> {
  if (!emails.length) return;
  await db.query(
    `UPDATE users SET entra_object_id = $1, updated_at = now()
       WHERE id = (SELECT id FROM users
                    WHERE lower(email) = ANY($2::text[]) AND entra_object_id <> $1
                      AND erased_at IS NULL
                    ORDER BY created_at ASC LIMIT 1)
         AND NOT EXISTS (SELECT 1 FROM users WHERE entra_object_id = $1)`,
    [oid, emails],
  );
}

/**
 * Sync display_name + email from the token claims onto the user's OWN row — for users who signed in
 * before reconciliation populated their profile, or who are in no mapped group (reconcile skips
 * them). Only overwrites display_name when it is blank or was wrongly set to the raw OID, and email
 * only when it is blank.
 */
export async function backfillDisplayName(db: Db, oid: string, name: string, email: string): Promise<void> {
  await db.query(
    `UPDATE users
        SET display_name = $1,
            email = CASE WHEN (email IS NULL OR email = '') THEN $2 ELSE email END
      WHERE entra_object_id = $3
        AND (display_name IS NULL OR display_name = '' OR display_name = $3)`,
    [name, email, oid],
  );
}

/**
 * Run the identity step for one authenticated Entra identity. The relink is AWAITED — access
 * resolution keys on the oid right after — and non-fatal (correctly-keyed rows already match by
 * oid). The name backfill is cosmetic, so it is fire-and-forget: it never blocks or fails the
 * caller.
 */
export async function syncSignInIdentity(c: SignInClaims, db: Db = pool): Promise<void> {
  try {
    await relinkIdentityByEmail(db, c.oid, signInEmails(c));
  } catch {
    /* non-fatal: correctly-keyed rows already match by oid */
  }
  const name = c.name ?? "";
  if (name) {
    const email = c.email ?? c.preferredUsername ?? "";
    void backfillDisplayName(db, c.oid, name, email).catch(() => {});
  }
}
