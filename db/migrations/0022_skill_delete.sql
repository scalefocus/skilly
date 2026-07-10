-- Permanent skill deletion (platform-admin, archived skills only) — SKILLY_SPEC.md §7.
-- Skill versions are immutable: the guard in 0001 forbids ALL deletes, which also blocks the
-- ON DELETE CASCADE from skills. We keep that protection for every normal path, but allow a
-- DELETE when the caller opts in for the current transaction via a namespaced GUC the delete
-- routine sets (`SET LOCAL skilly.allow_version_delete = 'on'`). Nothing else can delete a
-- version. Audit_log stays append-only (the deletion is recorded there, never removed).
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
     OR COALESCE(NEW.artifact_sha256,'') <> COALESCE(OLD.artifact_sha256,'')
     OR COALESCE(NEW.external_ref,'')   <> COALESCE(OLD.external_ref,'') THEN
    RAISE EXCEPTION 'published skill_version content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
