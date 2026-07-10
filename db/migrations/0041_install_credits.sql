-- 0041: Contributor leaderboard — maintainer-attributed installs (SKILLY_SPEC.md §21).
--
-- The leaderboard moves from crediting a skill's *proposer* to crediting its *current explicit
-- maintainers*, point-in-time: each git clone is attributed, AT CLONE TIME, to every explicit
-- maintainer (skill_maintainers) of the skill then. We snapshot that into install_credits so a
-- later maintainer change never moves past credit (removal stops only future credit; the proposer
-- keeps what they earned while listed). Namespace admins' implicit maintainership earns nothing.
BEGIN;

-- One row per (install, maintainer-credited-at-that-instant). access_log.id is UUID. Both FKs
-- cascade: if an install row is ever removed its credits go too; a hard-deleted user's credits go
-- too. (GDPR erasure is UPDATE-not-DELETE, so it deletes credits explicitly in lib/eraseUser.ts +
-- the SCIM erase path — the cascade is only a hard-delete backstop.)
CREATE TABLE install_credits (
  access_log_id UUID NOT NULL REFERENCES access_log(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  PRIMARY KEY (access_log_id, user_id)
);
-- Leaderboard aggregates group by user; the 30d window joins access_log for created_at.
CREATE INDEX idx_install_credits_user ON install_credits (user_id);

-- Table-level grants for skilly_app are inherited from the default privileges set in 0002.

-- Re-create the per-clone recorder to ALSO fan out credit to the skill's current explicit
-- maintainers. Now plpgsql (was sql) so we can capture the inserted access_log id. Still one
-- round-trip from the gateway, still atomic, still SECURITY INVOKER (app-role grants apply),
-- still never logs credentials.
CREATE OR REPLACE FUNCTION record_git_access(p_skill_id uuid, p_user_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_access_id uuid;
BEGIN
  INSERT INTO access_log (actor_user_id, skill_id, skill_version_id, source)
  VALUES (p_user_id, p_skill_id, NULL, 'git')
  RETURNING id INTO v_access_id;

  UPDATE skills SET install_count = install_count + 1 WHERE id = p_skill_id;

  INSERT INTO install_counters (month, total)
  VALUES (date_trunc('month', now())::date, 1)
  ON CONFLICT (month) DO UPDATE SET total = install_counters.total + 1;

  -- Credit each current explicit maintainer of the skill (snapshot at install time). Empty list
  -- => no rows => credit forfeited (never reassigned). Active, non-erased users only.
  INSERT INTO install_credits (access_log_id, user_id)
  SELECT v_access_id, sm.user_id
    FROM skill_maintainers sm
    JOIN users u ON u.id = sm.user_id
   WHERE sm.skill_id = p_skill_id AND u.status = 'active' AND u.erased_at IS NULL
  ON CONFLICT DO NOTHING;
END;
$$;

-- One-time backfill: seed credits for installs that predate this table, using the PRIOR attribution
-- model (the skill's original proposer(s) — accepted create/new-version proposals), so the board
-- stays continuous across the cutover. Excludes erased users. Matches the legacy multi-proposer
-- credit (one row per install x proposer).
INSERT INTO install_credits (access_log_id, user_id)
SELECT al.id, pr.user_id
  FROM access_log al
  JOIN (
    SELECT DISTINCT p.submitted_by AS user_id, s.id AS skill_id
      FROM proposals p
      LEFT JOIN skill_versions sv ON sv.id = p.materialized_version_id
      JOIN skills s ON s.id = coalesce(p.target_skill_id, sv.skill_id)
     WHERE p.state = 'accepted'
  ) pr ON pr.skill_id = al.skill_id
  JOIN users u ON u.id = pr.user_id
 WHERE al.source = 'git' AND al.skill_id IS NOT NULL
   AND u.status = 'active' AND u.erased_at IS NULL
ON CONFLICT DO NOTHING;

COMMIT;
