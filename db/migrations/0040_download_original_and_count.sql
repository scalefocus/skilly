-- 0040: detail-page download serves the ORIGINAL uploaded bundle verbatim, and a user's first
-- download counts toward installs (SKILLY_SPEC.md §6, §10, §17).
--   (a) skill_versions.artifact_filename — the original uploaded filename (e.g. my-skill.skill),
--       so the download streams the bundle back with its original extension instead of re-packing
--       by harness. Nullable: pre-0040 hosted versions and Pointer mirrors (no upload) stay NULL
--       and fall back to magic-byte sniff / harness at download time.
--   (b) skill_downloads — per-user first-download ledger ((skill_id, user_id) PK) used purely to
--       dedupe the install bump so a download counts ONCE per user, never per click.
--   (c) record_skill_download() — one-call recorder (mirrors record_git_access, 0030): inserts the
--       ledger row and, ONLY on a fresh insert, bumps skills.install_count + the current month's
--       install_counters + an access_log row (source='download'). A download is never an install
--       TOKEN, so it is never listed on the Installed Skills page (§23).
--   (d) Extend skill_versions_guard() to pin artifact_filename in the immutable content set (§22,
--       invariant #2) — it is part of the version's frozen artifact identity.
BEGIN;

-- (a) original filename on the version.
ALTER TABLE skill_versions ADD COLUMN IF NOT EXISTS artifact_filename TEXT;

-- (b) per-user first-download ledger (dedupe only).
CREATE TABLE IF NOT EXISTS skill_downloads (
  skill_id uuid        NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  user_id  uuid        NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  first_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, user_id)
);

-- (c) one-call first-download recorder. Returns TRUE when this was the user's first download of
-- the skill (and the counters were bumped), FALSE on a repeat (no-op). SECURITY INVOKER (default)
-- so the app role's grants still apply.
CREATE OR REPLACE FUNCTION record_skill_download(p_skill_id uuid, p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_first boolean;
BEGIN
  INSERT INTO skill_downloads (skill_id, user_id)
  VALUES (p_skill_id, p_user_id)
  ON CONFLICT (skill_id, user_id) DO NOTHING;

  GET DIAGNOSTICS v_first = ROW_COUNT;  -- 1 = inserted (first time), 0 = already present
  IF NOT v_first THEN
    RETURN false;
  END IF;

  INSERT INTO access_log (actor_user_id, skill_id, skill_version_id, source)
  VALUES (p_user_id, p_skill_id, NULL, 'download');

  UPDATE skills SET install_count = install_count + 1 WHERE id = p_skill_id;

  INSERT INTO install_counters (month, total)
  VALUES (date_trunc('month', now())::date, 1)
  ON CONFLICT (month) DO UPDATE SET total = install_counters.total + 1;

  RETURN true;
END;
$$;

-- (d) pin artifact_filename in the version-immutability guard (keeps 0039's delete carve-out +
-- full UPDATE column set; adds the new column). Set once at insert, never updated.
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
     OR NEW.is_prerelease <> OLD.is_prerelease THEN
    RAISE EXCEPTION 'published skill_version content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
