-- 0057: per-type maintainer-notification opt-outs (§3 users, §12 "Maintainer notification
-- preferences"). Both default ON for everyone, including existing users. Row-level — the
-- worker filters opted-out users out of the recipient set at insert time (no in-app row,
-- no email), unlike the channel-level email_notifications (0053) which only suppresses
-- email for rows that exist. App-role grants inherit from 0002 (default privileges).
ALTER TABLE users ADD COLUMN IF NOT EXISTS drift_notifications BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS new_version_notifications BOOLEAN NOT NULL DEFAULT true;
