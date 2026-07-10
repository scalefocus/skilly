-- Security regression fix: restore the full version-immutability guard (SKILLY_SPEC.md §22,
-- invariant #2). Migration 0017 pinned the FULL immutable content set on UPDATE
-- (semver, skill_id, artifact_sha256, artifact_object_key, external_ref, external_origin_url,
-- external_subdir, is_prerelease). The later 0022 re-CREATE OR REPLACE'd skill_versions_guard()
-- to add the permanent-delete carve-out but, in doing so, dropped four of those checks — the
-- live guard pinned only semver/skill_id/artifact_sha256/external_ref. That left a published
-- version's bytes (artifact_object_key), provenance (external_origin_url/external_subdir), and
-- prerelease flag mutable while the app role retains UPDATE — a bug or compromised process could
-- repoint them while keeping the recorded sha256.
--
-- This combines BOTH protections: keep 0022's delete carve-out (the skilly.allow_version_delete
-- GUC the permanent-delete routine sets) AND restore 0017's full UPDATE column set. Only status
-- (yank/restore) and git_published (the synthesis flag) may change post-insert; content_sha256
-- (the backfill column, 0034) is intentionally not pinned.
BEGIN;

CREATE OR REPLACE FUNCTION skill_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Permitted only inside an explicit permanent-deletion transaction (see lib/manage.ts).
    IF current_setting('skilly.allow_version_delete', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'skill_versions are immutable; delete is forbidden';
  END IF;
  IF NEW.semver <> OLD.semver
     OR NEW.skill_id <> OLD.skill_id
     OR COALESCE(NEW.artifact_sha256,'')      <> COALESCE(OLD.artifact_sha256,'')
     OR COALESCE(NEW.artifact_object_key,'')  <> COALESCE(OLD.artifact_object_key,'')
     OR COALESCE(NEW.external_ref,'')         <> COALESCE(OLD.external_ref,'')
     OR COALESCE(NEW.external_origin_url,'')   <> COALESCE(OLD.external_origin_url,'')
     OR COALESCE(NEW.external_subdir,'')       <> COALESCE(OLD.external_subdir,'')
     OR NEW.is_prerelease <> OLD.is_prerelease THEN
    RAISE EXCEPTION 'published skill_version content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
