// DEV-ONLY: which user the passwordless `dev` credentials provider may sign in (SKILLY_SPEC.md §16
// item 18). The provider itself exists only under SKILLY_DEV_AUTH=1 (auth.ts), and a production boot
// refuses that flag (instrumentation.ts). Kept free of the DB pool so it unit-tests in isolation.
//
// No `oid` → the configured dev admin (SKILLY_DEV_OID), as the provider always did.
// An `oid` → only the dev admin itself, or one of the 16 e2e worker users that `db/seed.e2e.sql`
// seeds for the Jenkins e2e run (one per Playwright worker). Anything else — a seeded non-admin such
// as Alice, an arbitrary string — is refused, so the dev provider cannot impersonate other users.

/** The e2e worker user ids: `e2e-worker-01-oid` … `e2e-worker-16-oid`. */
export const E2E_WORKER_OID = /^e2e-worker-(0[1-9]|1[0-6])-oid$/;

/** Highest worker number `db/seed.e2e.sql` seeds (and the Jenkins E2E_WORKERS ceiling). */
export const E2E_WORKER_USERS = 16;

/** The oid of e2e worker `n` (1-based), zero-padded to two digits. */
export function e2eWorkerOid(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > E2E_WORKER_USERS) {
    throw new RangeError(`e2e worker number must be a whole number from 1 to ${E2E_WORKER_USERS} (got ${n})`);
  }
  return `e2e-worker-${String(n).padStart(2, "0")}-oid`;
}

/**
 * The entra_object_id the dev provider signs in for this request, or `null` to refuse it.
 * `requested` is the optional `oid` credential; `devOid` is SKILLY_DEV_OID (default "dev-oid").
 */
export function resolveDevSignInOid(requested: unknown, devOid: string | undefined): string | null {
  const admin = devOid || "dev-oid";
  if (requested === undefined || requested === null || requested === "") return admin;
  if (typeof requested !== "string") return null;
  if (requested === admin || E2E_WORKER_OID.test(requested)) return requested;
  return null;
}
