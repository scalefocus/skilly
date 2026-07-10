-- Presence: record each user's most recent authenticated activity so the Administration
-- page can show a "Currently online" list (SKILLY_SPEC.md §4). Nullable + no backfill —
-- a user has no presence until their next request (we must NOT show everyone as online on
-- day one). Stamped fire-and-forget, throttled per-user, via the currentAccess() choke point.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;

-- The online query (last_seen > now() - interval '5 minutes', ordered last_seen DESC) runs on
-- every admin poll; the users table is org-sized, so a lightweight btree index is cheap insurance.
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users (last_seen DESC);
