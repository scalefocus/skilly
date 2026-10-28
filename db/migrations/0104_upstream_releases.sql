-- 0104: Upstream release alerts (SKILLY_SPEC.md §63).
--
--   skill_upstream_releases            one row per checked pointer skill: the baseline the last
--                                      check ran against (its origin, folder and pin kind), the
--                                      newest stable upstream release above it, whether that
--                                      release changed the skill's folder, the once-per-release
--                                      notification dedup (`notified_ref`) and the skip. Written
--                                      by the worker's upstream-release sweep, by Skip / Un-skip,
--                                      and by the pointer refresh, which records the baseline's pin
--                                      kind when it detects drift (so the page can tell a moved
--                                      branch from a moved tag while the sweep is off). Whether a
--                                      release is *pending* is derived on read
--                                      (@skilly/shared/upstream-releases), never stored.
--                                      `checked_at` NULL = the sweep has not checked it yet.
--   users.upstream_release_notifications the eighth maintainer notification preference (§12 / §63.10).
--
-- The `upstream_releases_enabled` platform setting needs no seed row (absent ⇒ on, §63.10).
-- No backfill: the sweep fills the table as it checks each skill.
BEGIN;

CREATE TABLE IF NOT EXISTS skill_upstream_releases (
  skill_id            UUID PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
  baseline_version_id UUID NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  origin_url          TEXT NOT NULL,
  subdir              TEXT,
  pin_kind            TEXT NOT NULL
                      CONSTRAINT skill_upstream_releases_pin_kind_check
                      CHECK (pin_kind IN ('semver_tag', 'tag', 'branch', 'commit', 'registry')),
  release_ref         TEXT,
  release_semver      TEXT,
  release_commit      TEXT,
  release_bump        TEXT
                      CONSTRAINT skill_upstream_releases_bump_check
                      CHECK (release_bump IN ('major', 'minor', 'patch')),
  files_changed       BOOLEAN,
  detected_at         TIMESTAMPTZ,
  notified_ref        TEXT,
  skipped_ref         TEXT,
  skipped_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  skipped_at          TIMESTAMPTZ,
  checked_at          TIMESTAMPTZ,
  last_error          TEXT
);

-- The sweep picks the least recently checked skills first.
CREATE INDEX IF NOT EXISTS idx_skill_upstream_releases_checked ON skill_upstream_releases (checked_at);

ALTER TABLE users ADD COLUMN IF NOT EXISTS upstream_release_notifications BOOLEAN NOT NULL DEFAULT true;

COMMIT;
