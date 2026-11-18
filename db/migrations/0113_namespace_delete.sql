-- 0113: deleting a namespace (SKILLY_SPEC.md §72).
--
--  * audit_log.namespace_id loses its foreign key. Every namespace has at least its
--    `namespace.created` audit row, so the key would block every delete, and append-only rows can't be
--    set to NULL. The column and idx_audit_namespace stay; no audit row changes (§72.8, invariant #5).
--  * A partial index finds a deleted namespace's `namespace.deleted` snapshot, which the audit page
--    uses to label the old rows "@slug (deleted)" (§72.7).
--  * repo_disk_purges: the worker's queue of deleted namespaces whose repositories are still on disk.
--    While a row exists its slug can't be reused (§72.4). Table grants come from the 0002 default
--    privileges.
BEGIN;

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_namespace_id_fkey;

CREATE INDEX IF NOT EXISTS idx_audit_namespace_deleted
  ON audit_log (target_id) WHERE action = 'namespace.deleted';

CREATE TABLE IF NOT EXISTS repo_disk_purges (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace_slug TEXT NOT NULL UNIQUE,
  -- The deleted namespace's id, for the record only: the row it named is gone (no FK).
  namespace_id   UUID,
  -- The dropped aliases as [{ "slug": "...", "skillId": "..." }]: moved-out skills whose repo may
  -- still sit at the old address and must be relocated before the directory is removed.
  relocations    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
