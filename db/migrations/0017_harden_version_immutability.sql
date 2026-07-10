-- Security hardening (audit P0-3): the original skill_versions_guard pinned only
-- semver/skill_id/artifact_sha256/external_ref, leaving artifact_object_key, external_origin_url,
-- external_subdir, and is_prerelease mutable while the app role retains UPDATE. A bug or
-- compromised process could repoint a published version's bytes/provenance while keeping the
-- recorded sha256 — violating invariant #2 (versions are immutable). Pin the full content set;
-- only status (yank/restore) and git_published (the synthesis flag) may change post-insert.
BEGIN;

CREATE OR REPLACE FUNCTION skill_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
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
