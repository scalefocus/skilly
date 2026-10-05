-- Installed-version freshness (SKILLY_SPEC.md §23 "Installed-version freshness", §39).
--
--   tokens.last_served_semver   the semver the gateway RESOLVED TO SERVE this install token on its
--                               most recent /info/refs advertisement: the token's pinned_semver when
--                               pinned, otherwise the latest stable `main` pointed at. A plain string,
--                               deliberately NOT an FK to skill_versions — a later version delete
--                               leaves the row readable (the Installed page then shows "withdrawn").
--   tokens.last_cloned_at       when that serving happened. Re-stamped on EVERY clone (unlike
--                               used_at / client_user_agent / client_ip, which are first-clone only).
--
-- Both are NULL on `marketplace` tokens (they have their own cursor, last_served_commit, §30.7).
--
-- Backfill: installs used before this migration get last_served_semver = pinned_semver when pinned
-- (that is what their URL names). Latest-tracking ones stay NULL — we cannot know what `main` was at
-- their last clone, so they read "unknown" until their next clone (§39.1 #3). last_cloned_at stays
-- NULL for both.
--
-- No grant changes: the app role already owns UPDATE on tokens (0029).
BEGIN;

ALTER TABLE tokens
  ADD COLUMN IF NOT EXISTS last_served_semver TEXT,
  ADD COLUMN IF NOT EXISTS last_cloned_at     TIMESTAMPTZ;

UPDATE tokens
   SET last_served_semver = pinned_semver
 WHERE type = 'install'
   AND used_at IS NOT NULL
   AND pinned_semver IS NOT NULL
   AND last_served_semver IS NULL;

COMMIT;
