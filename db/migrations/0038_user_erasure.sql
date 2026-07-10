-- "Delete User Info" / GDPR erasure (SKILLY_SPEC.md §4). Erasure is anonymize-in-place: the users
-- row is kept and scrubbed (not deleted — messages/proposals/audit FKs forbid a hard delete), and
-- its Entra link is DETACHED (entra_object_id → NULL) so the person can return later as a fresh
-- account. `erased_at` marks the tombstone.
BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS erased_at TIMESTAMPTZ;

-- Allow detaching the Entra identity on erasure. The existing UNIQUE index permits multiple NULLs
-- in Postgres, so many erased tombstones coexist and a re-provisioned return user gets a new row.
ALTER TABLE users ALTER COLUMN entra_object_id DROP NOT NULL;

COMMIT;
