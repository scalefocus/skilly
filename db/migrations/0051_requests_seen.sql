-- Fourth nav "last seen" marker, same pattern as catalog_seen_at / review_seen_at (0026) and
-- system_log_seen_at (0033): drives the Requested-skills sidebar badge + per-card "new" tags (§26).
BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS requests_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

COMMIT;
