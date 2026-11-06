-- 0107: Visit frequency and new users (SKILLY_SPEC.md §66).
--
--   users.first_seen     the user's FIRST authenticated activity, stamped once by touchLastSeen
--                        (coalesce, never moved); NULL = never visited. Drives the hover card's
--                        Visits and New user rows and the new-user hat (§66.2, §66.3).
--   user_visit_days      one row per user per UTC day with any authenticated activity — the only
--                        per-user activity history skilly keeps. Kept for 28 days (a leader-only
--                        worker sweep prunes older rows daily); deleted on GDPR erasure (§4).
--   visits_since         platform_settings: the UTC date collection began, the floor of the
--                        Visits pro-rating (§66.2). Written once here; a re-run never moves it.
--
-- Backfill: existing users who have visited get first_seen = created_at. created_at is never later
-- than a first visit, so this is exact for accounts created in the last 30 days and never makes an
-- old account "new" (§66.1 decision 9). Erased tombstones stay NULL. user_visit_days starts empty:
-- last_seen holds only the latest activity, so there is no history to reconstruct.
-- `visits_enabled` is not inserted — absent means on (§66.6).
-- (Table-level grants for skilly_app are inherited from the default privileges set in 0002.)
BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ;

UPDATE users
   SET first_seen = created_at
 WHERE first_seen IS NULL
   AND last_seen IS NOT NULL
   AND erased_at IS NULL;

CREATE TABLE IF NOT EXISTS user_visit_days (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     DATE NOT NULL,
  PRIMARY KEY (user_id, day)
);

-- The daily prune deletes by day across every user.
CREATE INDEX IF NOT EXISTS user_visit_days_day_idx ON user_visit_days (day);

INSERT INTO platform_settings (key, value)
VALUES ('visits_since', to_jsonb(((now() AT TIME ZONE 'utc')::date)::text))
ON CONFLICT (key) DO NOTHING;

COMMIT;
