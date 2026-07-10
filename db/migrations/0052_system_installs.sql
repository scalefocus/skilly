-- 0052: system installations (SKILLY_SPEC.md §23 "System installations"). A system install is an
-- `install` token owned by the platform, not a person — the sanctioned CI/machine path. It has no
-- user_id; provenance (which platform admin minted it) lives in created_by_user_id. System clones
-- are marked in access_log so analytics can tell them apart from legacy anonymous/tokenless rows.
BEGIN;

-- System tokens have no owning user.
ALTER TABLE tokens ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Pairing invariant: an install row is system iff it has no user. (Legacy pat/one_time rows were
-- purged in 0029; the CHECK is scoped to 'install' so dormant enum values stay unconstrained.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tokens_system_user_pairing') THEN
    ALTER TABLE tokens ADD CONSTRAINT tokens_system_user_pairing
      CHECK (type <> 'install' OR is_system = (user_id IS NULL));
  END IF;
END $$;

-- The Installed Skills "System installs" view lists system rows platform-wide.
CREATE INDEX IF NOT EXISTS idx_tokens_install_system ON tokens (skill_id) WHERE type = 'install' AND is_system;

-- Distinguish system clones from legacy anonymous/tokenless clones (both have a NULL actor).
ALTER TABLE access_log ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

-- Per-clone recorder grows two flags: p_is_system marks the access_log row; p_count_install is
-- true only on a system token's FIRST clone (the used_at stamping — determined by the caller),
-- which is the per-token analogue of the per-user first-install rule: each system installation
-- bumps install_count exactly once. System clones never touch the per-user skill_installs ledger
-- and never write install_credits (no leaderboard fan-out). §21/§23.
DROP FUNCTION IF EXISTS record_git_access(uuid, uuid);
CREATE OR REPLACE FUNCTION record_git_access(
  p_skill_id uuid,
  p_user_id uuid,
  p_is_system boolean DEFAULT false,
  p_count_install boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_access_id uuid;
  v_first boolean := false;
BEGIN
  INSERT INTO access_log (actor_user_id, skill_id, skill_version_id, source, is_system)
  VALUES (p_user_id, p_skill_id, NULL, 'git', p_is_system)
  RETURNING id INTO v_access_id;

  -- Monthly platform total = activity (every clone), unchanged.
  INSERT INTO install_counters (month, total)
  VALUES (date_trunc('month', now())::date, 1)
  ON CONFLICT (month) DO UPDATE SET total = install_counters.total + 1;

  -- Adoption: count each (user, skill) once. Legacy tokenless clones (null user, not system)
  -- stay activity-only.
  IF p_user_id IS NOT NULL THEN
    INSERT INTO skill_installs (skill_id, user_id) VALUES (p_skill_id, p_user_id)
    ON CONFLICT (skill_id, user_id) DO NOTHING;
    v_first := FOUND;  -- true only on the user's FIRST install of this skill
  ELSIF p_is_system AND p_count_install THEN
    -- One bump per system installation, at first clone. No credits, no skill_installs.
    UPDATE skills SET install_count = install_count + 1 WHERE id = p_skill_id;
  END IF;

  IF v_first THEN
    UPDATE skills SET install_count = install_count + 1 WHERE id = p_skill_id;
    -- Credit current maintainers (leaderboard), EXCLUDING the installer; active/non-erased only.
    INSERT INTO install_credits (access_log_id, user_id)
    SELECT v_access_id, sm.user_id
      FROM skill_maintainers sm JOIN users u ON u.id = sm.user_id
     WHERE sm.skill_id = p_skill_id AND sm.user_id <> p_user_id
       AND u.status = 'active' AND u.erased_at IS NULL
    ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

COMMIT;
