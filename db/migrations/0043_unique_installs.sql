-- 0043: count installs once per (user, skill) so the stat can't be inflated by re-cloning
-- (SKILLY_SPEC.md §21). The ADOPTION metrics — skills.install_count and the leaderboard's
-- install_credits — now count each user at most once per skill, forever, version-agnostic. The
-- raw access_log (audit + usage time-series) and the monthly install_counters stay per-clone
-- ACTIVITY. Tokenless (null-user) clones are activity-only. Leaderboard credit additionally
-- excludes the installer themselves (no self-credit for installing a skill you maintain).
BEGIN;

-- Unified per-(user,skill) adoption ledger, shared by the git-install and download paths so a
-- user who downloads then installs (or vice-versa) counts ONCE. Supersedes skill_downloads
-- (0040), which is left in place (unused) to avoid a destructive drop. App-role grants inherit
-- from the 0002 default privileges.
CREATE TABLE IF NOT EXISTS skill_installs (
  skill_id  UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  first_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_skill_installs_user ON skill_installs (user_id);

-- Backfill the distinct-adopter set from history: git clones (known user) ∪ first-downloads.
INSERT INTO skill_installs (skill_id, user_id, first_at)
SELECT skill_id, user_id, min(first_at)
  FROM (
    SELECT skill_id, actor_user_id AS user_id, created_at AS first_at
      FROM access_log WHERE source = 'git' AND skill_id IS NOT NULL AND actor_user_id IS NOT NULL
    UNION ALL
    SELECT skill_id, user_id, first_at FROM skill_downloads
  ) x
 GROUP BY skill_id, user_id
ON CONFLICT (skill_id, user_id) DO NOTHING;

-- Per-clone recorder, now de-duping the adoption metrics. access_log + monthly counter still fire
-- on every clone (activity); install_count + install_credits fire ONLY on a user's first install.
CREATE OR REPLACE FUNCTION record_git_access(p_skill_id uuid, p_user_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_access_id uuid;
  v_first boolean := false;
BEGIN
  INSERT INTO access_log (actor_user_id, skill_id, skill_version_id, source)
  VALUES (p_user_id, p_skill_id, NULL, 'git')
  RETURNING id INTO v_access_id;

  -- Monthly platform total = activity (every clone), unchanged.
  INSERT INTO install_counters (month, total)
  VALUES (date_trunc('month', now())::date, 1)
  ON CONFLICT (month) DO UPDATE SET total = install_counters.total + 1;

  -- Adoption: count each (user, skill) once. Tokenless clones (null user) are activity-only.
  IF p_user_id IS NOT NULL THEN
    INSERT INTO skill_installs (skill_id, user_id) VALUES (p_skill_id, p_user_id)
    ON CONFLICT (skill_id, user_id) DO NOTHING;
    v_first := FOUND;  -- true only on the user's FIRST install of this skill
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

-- Download recorder, now sharing the unified skill_installs ledger (so a download doesn't double
-- count with a git install) and crediting maintainers on the first adoption (self-excluded). A
-- repeat — or a download after a prior install — is a no-op. Returns true only on first adoption.
CREATE OR REPLACE FUNCTION record_skill_download(p_skill_id uuid, p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_access_id uuid;
BEGIN
  INSERT INTO skill_installs (skill_id, user_id) VALUES (p_skill_id, p_user_id)
  ON CONFLICT (skill_id, user_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN false;  -- already adopted (prior download OR install) — never double-count
  END IF;

  INSERT INTO access_log (actor_user_id, skill_id, skill_version_id, source)
  VALUES (p_user_id, p_skill_id, NULL, 'download')
  RETURNING id INTO v_access_id;

  UPDATE skills SET install_count = install_count + 1 WHERE id = p_skill_id;

  INSERT INTO install_counters (month, total)
  VALUES (date_trunc('month', now())::date, 1)
  ON CONFLICT (month) DO UPDATE SET total = install_counters.total + 1;

  INSERT INTO install_credits (access_log_id, user_id)
  SELECT v_access_id, sm.user_id
    FROM skill_maintainers sm JOIN users u ON u.id = sm.user_id
   WHERE sm.skill_id = p_skill_id AND sm.user_id <> p_user_id
     AND u.status = 'active' AND u.erased_at IS NULL
  ON CONFLICT DO NOTHING;

  RETURN true;
END;
$$;

-- ── Backfill the adoption metrics to the new (deduped, self-excluded) definition ──────────────
-- Existing install_credits were one-per-clone; collapse them to the first install per (skill,
-- installer), drop tokenless-clone credits, and drop self-install credits. (Downloads never wrote
-- credits before, so every existing credit row is tied to a 'git' access_log row.)
DELETE FROM install_credits ic USING access_log al
 WHERE ic.access_log_id = al.id AND al.actor_user_id IS NULL;

DELETE FROM install_credits ic USING access_log al
 WHERE ic.access_log_id = al.id AND al.actor_user_id = ic.user_id;

DELETE FROM install_credits ic USING access_log al
 WHERE ic.access_log_id = al.id
   AND al.id <> (
     SELECT a2.id FROM access_log a2
      WHERE a2.skill_id = al.skill_id AND a2.actor_user_id = al.actor_user_id AND a2.source = 'git'
      ORDER BY a2.created_at ASC, a2.id ASC LIMIT 1
   );

-- Recompute install_count as the number of unique adopters (was total clones + downloads). This
-- deliberately LOWERS existing popularity numbers to the honest distinct-user count.
UPDATE skills s SET install_count = COALESCE(
  (SELECT count(*) FROM skill_installs si WHERE si.skill_id = s.id), 0);

COMMIT;
