-- 0097: pointer versions pin a commit, mirrors can be quarantined, and the scan gate fails closed
-- (SKILLY_SPEC.md §49.2, §49.3, §49.13; October 2026 OWASP review, V5/V6/V7).
--
--   version_status                 gains 'quarantined' — a mirrored pointer version whose scan
--                                  verdict was `critical`. Never latest, never synthesized, never
--                                  served; released or yanked by a platform / owning-namespace
--                                  admin (§49.2).
--   skill_versions.external_commit the 40-hex commit the pointer ref resolved to at verification
--                                  (null for registry-origin pointers and every pre-0097 row — no
--                                  backfill). Joins the immutable pinned set of skill_versions_guard().
--   pending_mirrors.external_commit the same pin, copied from the proposal's payload by the accept
--                                  path into the mirror queue row so the mirror can refuse with
--                                  `upstream_moved` when HEAD differs (§49.3).
--   pending_mirrors.prescan_content_sha256
--                                  the proposal pre-scan report's content digest (64 hex or null),
--                                  copied onto the queue row at accept so the mirror can refuse
--                                  with `content_changed` when what it packs differs from what was
--                                  reviewed (§49.3).
--   scan_reports.content_sha256    the digest of the tree the pre-scan actually scanned; the mirror
--                                  compares it with what it cloned (`content_changed`).
--   proposals.routed_reason        gains 'scan_pending' — a direct publish routed to review because
--                                  the scan verdict was missing and the submitter lacks override
--                                  authority (§49.2).
--
-- Not constrained in the schema (free TEXT, nothing to alter): scan_reports.status gains the
-- 'source_changed' value and notifications.type gains 'skill.malware_detected' /
-- 'skill.version_quarantined' — both are enforced by the application.
--
-- NO BEGIN/COMMIT around the enum change: `ALTER TYPE ... ADD VALUE` cannot run inside a
-- transaction block together with statements that use the new label (same pattern as 0064/0065;
-- psql autocommits it). The remaining DDL is wrapped and idempotent.

ALTER TYPE version_status ADD VALUE IF NOT EXISTS 'quarantined';

BEGIN;

-- ── The pinned upstream commit ──────────────────────────────────────────────────────────────
ALTER TABLE skill_versions ADD COLUMN IF NOT EXISTS external_commit TEXT;
ALTER TABLE skill_versions DROP CONSTRAINT IF EXISTS skill_versions_external_commit_check;
ALTER TABLE skill_versions
  ADD CONSTRAINT skill_versions_external_commit_check
  CHECK (external_commit IS NULL OR external_commit ~ '^[0-9a-f]{40}$');

ALTER TABLE pending_mirrors ADD COLUMN IF NOT EXISTS external_commit TEXT;
ALTER TABLE pending_mirrors DROP CONSTRAINT IF EXISTS pending_mirrors_external_commit_check;
ALTER TABLE pending_mirrors
  ADD CONSTRAINT pending_mirrors_external_commit_check
  CHECK (external_commit IS NULL OR external_commit ~ '^[0-9a-f]{40}$');

-- The pre-scan report's content digest, copied onto the queue row at accept (§49.3) so the mirror
-- can compare the tree it packs against the one that was reviewed (`content_changed`).
ALTER TABLE pending_mirrors ADD COLUMN IF NOT EXISTS prescan_content_sha256 TEXT;
ALTER TABLE pending_mirrors DROP CONSTRAINT IF EXISTS pending_mirrors_prescan_content_sha256_check;
ALTER TABLE pending_mirrors
  ADD CONSTRAINT pending_mirrors_prescan_content_sha256_check
  CHECK (prescan_content_sha256 IS NULL OR prescan_content_sha256 ~ '^[0-9a-f]{64}$');

-- external_commit joins the immutable content set (keeps 0039's delete carve-out and the full
-- 0040 UPDATE column set; only status and git_published stay mutable post-insert — §22,
-- invariant #2).
CREATE OR REPLACE FUNCTION skill_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('skilly.allow_version_delete', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'skill_versions are immutable; delete is forbidden';
  END IF;
  IF NEW.semver <> OLD.semver
     OR NEW.skill_id <> OLD.skill_id
     OR COALESCE(NEW.artifact_sha256,'')      <> COALESCE(OLD.artifact_sha256,'')
     OR COALESCE(NEW.artifact_object_key,'')  <> COALESCE(OLD.artifact_object_key,'')
     OR COALESCE(NEW.artifact_filename,'')    <> COALESCE(OLD.artifact_filename,'')
     OR COALESCE(NEW.external_ref,'')         <> COALESCE(OLD.external_ref,'')
     OR COALESCE(NEW.external_origin_url,'')   <> COALESCE(OLD.external_origin_url,'')
     OR COALESCE(NEW.external_subdir,'')       <> COALESCE(OLD.external_subdir,'')
     OR COALESCE(NEW.external_commit,'')       <> COALESCE(OLD.external_commit,'')
     OR NEW.is_prerelease <> OLD.is_prerelease THEN
    RAISE EXCEPTION 'published skill_version content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── The pre-scan's content digest ───────────────────────────────────────────────────────────
ALTER TABLE scan_reports ADD COLUMN IF NOT EXISTS content_sha256 TEXT;

-- ── routed_reason gains 'scan_pending' (0081 → 0091 → here) ─────────────────────────────────
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_routed_reason_check;
ALTER TABLE proposals
  ADD CONSTRAINT proposals_routed_reason_check
  CHECK (routed_reason IS NULL OR routed_reason IN ('content_risk', 'policy', 'scan_pending'));

COMMIT;
