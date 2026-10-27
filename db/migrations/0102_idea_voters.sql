-- 0102: Coming soon shows who upvoted (SKILLY_SPEC.md §60.2, §60.3).
--
--   users.idea_votes_hidden   hides the user's bubble from everyone else in the "Upvoted by" strips
--                             of Coming soon items (§60.1 decision 19). Their votes still count, and
--                             they still see their own bubble, marked "only you". False for every
--                             existing user, so votes cast before v2.45.0 show from the release on.
--   idx_feature_idea_votes_recent  serves "the most recent voters of an item" for the strip and its
--                             list, newest vote first.
--
-- No backfill. Votes stay ordinary mutable rows, never audit data (§11).
BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS idea_votes_hidden BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_feature_idea_votes_recent ON feature_idea_votes (idea_id, created_at DESC);

COMMIT;
