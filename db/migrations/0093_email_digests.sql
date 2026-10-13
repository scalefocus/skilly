-- Email digests (SKILLY_SPEC.md §48). Only email is batched; in-app rows and the webhook are
-- unchanged. The platform_settings keys (email_digests_enabled, email_digest_default_mode,
-- email_digest_hour, email_digest_weekday, email_digest_types) need no DDL: absent ⇒ the default.
--
--   users.email_digest              the user's frequency; NULL = follow the organization default.
--                                   No backfill — everyone starts on the default ("Each update").
--   users.email_digest_last_run_at  the last scheduled slot the digest sweep closed for the user
--                                   (sent, empty or dropped); NULL = first sight (§48.6).
--   users.email_digest_failures     consecutive transient send failures of the current digest.
--   notifications.digest_state      NULL = the row's email was never deferred; 'pending' = waiting
--                                   for the user's next digest; 'sent' / 'dropped' = settled.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_digest TEXT NULL
  CHECK (email_digest IN ('immediate', 'daily', 'weekly'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_digest_last_run_at TIMESTAMPTZ NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_digest_failures SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS digest_state TEXT NULL
  CHECK (digest_state IN ('pending', 'sent', 'dropped'));

CREATE INDEX IF NOT EXISTS idx_notifications_digest_pending
  ON notifications (user_id) WHERE digest_state = 'pending';
