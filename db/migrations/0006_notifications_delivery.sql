-- Tier 2: notification delivery tracking + PAT labels.
--   * notifications gain delivery bookkeeping so the worker leader can fan them out over
--     SMTP / webhook exactly once and retry on failure (SKILLY_SPEC.md §12).
--   * tokens gain an optional human label surfaced in the PAT management UI (§9).
-- New columns inherit the table-level grants from 0002 (skilly_app: SELECT/INSERT/UPDATE/DELETE).
BEGIN;

ALTER TABLE notifications ADD COLUMN delivered_at      TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN delivery_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN delivery_error    TEXT;

-- Fast "my unread" lookups and the leader's undelivered drain.
CREATE INDEX idx_notifications_user        ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_undelivered ON notifications(created_at) WHERE delivered_at IS NULL;

-- Optional label for Personal Access Tokens (e.g. "ci-runner", "laptop").
ALTER TABLE tokens ADD COLUMN label TEXT;

COMMIT;
