-- Per-user leaderboard visibility. Default false = shown on the contributor leaderboard;
-- users can hide themselves from their profile. SKILLY_SPEC.md §21.
BEGIN;

ALTER TABLE users ADD COLUMN leaderboard_hidden BOOLEAN NOT NULL DEFAULT false;

COMMIT;
