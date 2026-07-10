-- Track whether a version has been synthesized into its serving git repo.
-- The leader worker scans for git_published=false and publishes them. SKILLY_SPEC.md §6.
BEGIN;

ALTER TABLE skill_versions ADD COLUMN git_published BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX idx_skill_versions_unpublished
  ON skill_versions (skill_id) WHERE git_published = false;

COMMIT;
