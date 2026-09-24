-- Following people (SKILLY_SPEC.md §35).
--
--   user_follows         one row per (follower, followee). Unfollow hard-deletes the row; a
--                        re-follow creates a fresh one. Drives the follower notifications (§35.6),
--                        the leaderboard "followers" stat (§35.7) and two badges (§35.8).
--   users.allow_follows  "Allow others to follow me" (§35.3). Off PAUSES every follow on the user:
--                        the rows stay, but nothing reads them until it is turned back on.
--
-- No backfill: the table starts empty. Grants come from the 0002 default privileges; UPDATE is
-- revoked because a follow is only ever created or deleted, never edited (§35.13).
BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS allow_follows BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS user_follows (
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CONSTRAINT user_follows_no_self CHECK (follower_id <> followee_id)
);

-- The fan-out (all followers of X) and the leaderboard metric (followers of X, windowed).
CREATE INDEX IF NOT EXISTS idx_user_follows_followee ON user_follows (followee_id, created_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skilly_app') THEN
    REVOKE UPDATE ON user_follows FROM skilly_app;
  END IF;
END
$$;

COMMIT;
