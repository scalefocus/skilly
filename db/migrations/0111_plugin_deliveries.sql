-- 0111: plugin deliveries are not adoption (SKILLY_SPEC.md §21 "Plugin deliveries are not adoption",
-- §30.7). A plugin marketplace fetch delivers every listed skill at once; it now counts as REACH
-- (install_count, access_log, install_counters, the usage dashboard) and never as ADOPTION (the
-- leaderboard, Popular in your department, Skills you might like).
--
--   skill_installs.adopted_at  NULL = delivered only (a plugin marketplace delivered it and the
--                              person has not installed it deliberately); otherwise when they first
--                              installed it deliberately (clone with an install token, download, MCP
--                              read). first_at keeps meaning "when they first held it, by any route".
--   access_log.is_plugin       the row is a plugin marketplace delivery.
--
-- The recorders learn the difference, and history is recounted once (steps 1-7 below). The recount
-- deletes the install_credits of past deliveries with no backup, by decision: it cannot be undone.
BEGIN;

ALTER TABLE skill_installs ADD COLUMN IF NOT EXISTS adopted_at TIMESTAMPTZ;
ALTER TABLE access_log ADD COLUMN IF NOT EXISTS is_plugin BOOLEAN NOT NULL DEFAULT false;

-- ── The recorders ───────────────────────────────────────────────────────────────────────────────

-- Per-clone recorder (0052) gains p_plugin: the gateway's marketplace credit path passes true. A
-- plugin delivery writes the access_log row (flagged), the monthly counter, and the once-per-person
-- install_count bump, with the ledger row DELIVERED ONLY and no maintainer credit. A deliberate
-- clone of a skill the person holds as delivered only ADOPTS it: adopted_at, and the maintainers
-- of this moment are credited; install_count does not move again (it is still one person).
DROP FUNCTION IF EXISTS record_git_access(uuid, uuid, boolean, boolean);
CREATE OR REPLACE FUNCTION record_git_access(
  p_skill_id uuid,
  p_user_id uuid,
  p_is_system boolean DEFAULT false,
  p_count_install boolean DEFAULT false,
  p_plugin boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_access_id uuid;
  v_first boolean := false;
  v_adopt boolean := false;
BEGIN
  INSERT INTO access_log (actor_user_id, skill_id, skill_version_id, source, is_system, is_plugin)
  VALUES (p_user_id, p_skill_id, NULL, 'git', p_is_system, p_plugin)
  RETURNING id INTO v_access_id;

  -- Monthly platform total = activity (every clone), unchanged.
  INSERT INTO install_counters (month, total)
  VALUES (date_trunc('month', now())::date, 1)
  ON CONFLICT (month) DO UPDATE SET total = install_counters.total + 1;

  IF p_user_id IS NOT NULL THEN
    INSERT INTO skill_installs (skill_id, user_id, adopted_at)
    VALUES (p_skill_id, p_user_id, CASE WHEN p_plugin THEN NULL ELSE now() END)
    ON CONFLICT (skill_id, user_id) DO NOTHING;
    v_first := FOUND;  -- the person's FIRST time holding this skill, by any route
    IF v_first THEN
      UPDATE skills SET install_count = install_count + 1 WHERE id = p_skill_id;
    END IF;
    IF NOT p_plugin THEN
      IF v_first THEN
        v_adopt := true;
      ELSE
        UPDATE skill_installs SET adopted_at = now()
         WHERE skill_id = p_skill_id AND user_id = p_user_id AND adopted_at IS NULL;
        v_adopt := FOUND;  -- held as delivered only until now
      END IF;
    END IF;
  ELSIF p_is_system AND p_count_install THEN
    -- One bump per system installation, at first clone. No credits, no skill_installs.
    UPDATE skills SET install_count = install_count + 1 WHERE id = p_skill_id;
  END IF;

  IF v_adopt THEN
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

-- Download recorder (0043): a first download adopts, as before; a download of a skill held as
-- DELIVERED ONLY now adopts it too (it used to return early). The access_log row and the monthly
-- counter are written as for any first adoption through this door; install_count moves only when
-- the person did not hold the skill at all. Returns true when it adopted.
CREATE OR REPLACE FUNCTION record_skill_download(p_skill_id uuid, p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_access_id uuid;
  v_fresh boolean;
BEGIN
  INSERT INTO skill_installs (skill_id, user_id, adopted_at) VALUES (p_skill_id, p_user_id, now())
  ON CONFLICT (skill_id, user_id) DO NOTHING;
  v_fresh := FOUND;
  IF NOT v_fresh THEN
    UPDATE skill_installs SET adopted_at = now()
     WHERE skill_id = p_skill_id AND user_id = p_user_id AND adopted_at IS NULL;
    IF NOT FOUND THEN
      RETURN false;  -- already adopted (prior clone, download OR MCP read) — never double-count
    END IF;
  END IF;

  INSERT INTO access_log (actor_user_id, skill_id, skill_version_id, source)
  VALUES (p_user_id, p_skill_id, NULL, 'download')
  RETURNING id INTO v_access_id;

  IF v_fresh THEN
    UPDATE skills SET install_count = install_count + 1 WHERE id = p_skill_id;
  END IF;

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

-- MCP SKILL.md read recorder (0063): the same change as the download recorder.
CREATE OR REPLACE FUNCTION record_mcp_read(p_skill_id uuid, p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_access_id uuid;
  v_fresh boolean;
BEGIN
  INSERT INTO skill_installs (skill_id, user_id, adopted_at) VALUES (p_skill_id, p_user_id, now())
  ON CONFLICT (skill_id, user_id) DO NOTHING;
  v_fresh := FOUND;
  IF NOT v_fresh THEN
    UPDATE skill_installs SET adopted_at = now()
     WHERE skill_id = p_skill_id AND user_id = p_user_id AND adopted_at IS NULL;
    IF NOT FOUND THEN
      RETURN false;  -- already adopted (prior clone, download OR MCP read) — never double-count
    END IF;
  END IF;

  INSERT INTO access_log (actor_user_id, skill_id, skill_version_id, source)
  VALUES (p_user_id, p_skill_id, NULL, 'mcp_resource')
  RETURNING id INTO v_access_id;

  IF v_fresh THEN
    UPDATE skills SET install_count = install_count + 1 WHERE id = p_skill_id;
  END IF;

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

-- ── The recount ─────────────────────────────────────────────────────────────────────────────────
-- A function so the DB test runs the exact recount on its own fixture users (p_users) while the
-- migration runs it once for everyone (NULL). Executable by the database owner only. Safe to run
-- again: a ledger row adopted after it was first held (adopted_at > first_at) is never touched.
CREATE OR REPLACE FUNCTION recount_plugin_deliveries(p_users uuid[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_flagged integer;
  v_reclassified integer;
  v_credits integer;
  v_recovered integer;
  v_totals jsonb;
BEGIN
  -- 1. Every ledger row starts adopted.
  UPDATE skill_installs SET adopted_at = first_at
   WHERE adopted_at IS NULL AND (p_users IS NULL OR user_id = ANY (p_users));

  -- 2. Each person's marketplace start: the earliest of a marketplace token they still hold (its
  --    first fetch), their Bulk Buyer badge (earned at the first marketplace fetch, never lost) and
  --    their first same-instant burst. A person with none of these never had a marketplace.
  DROP TABLE IF EXISTS pg_temp._pd_bursts;
  CREATE TEMP TABLE _pd_bursts ON COMMIT DROP AS
    SELECT actor_user_id AS user_id, created_at
      FROM access_log
     WHERE source = 'git' AND actor_user_id IS NOT NULL AND NOT is_system
       AND (p_users IS NULL OR actor_user_id = ANY (p_users))
     GROUP BY actor_user_id, created_at
    HAVING count(*) > 1;
  DROP TABLE IF EXISTS pg_temp._pd_start;
  CREATE TEMP TABLE _pd_start ON COMMIT DROP AS
    SELECT user_id, min(at) AS start_at FROM (
      SELECT user_id, used_at AS at FROM tokens
       WHERE type = 'marketplace' AND user_id IS NOT NULL AND used_at IS NOT NULL
         AND (p_users IS NULL OR user_id = ANY (p_users))
      UNION ALL
      SELECT user_id, earned_at FROM user_achievements
       WHERE key = 'first_marketplace' AND (p_users IS NULL OR user_id = ANY (p_users))
      UNION ALL
      SELECT user_id, created_at FROM _pd_bursts
    ) t
     GROUP BY user_id;

  -- 3. Past deliveries. (a) A same-instant burst: a marketplace fetch records every skill it
  --    delivers in one transaction, so its rows share one timestamp; a direct clone is a statement
  --    of its own.
  UPDATE access_log a SET is_plugin = true
    FROM _pd_bursts b
   WHERE a.source = 'git' AND NOT a.is_system AND NOT a.is_plugin
     AND a.actor_user_id = b.user_id AND a.created_at = b.created_at;
  --    (b) On or after the person's marketplace start, with nothing proving it deliberate: no used
  --    personal install token for that skill whose first clone is at most a minute after the row.
  --    A lone delivery (a skill added to the marketplace later) looks exactly like a direct clone.
  UPDATE access_log a SET is_plugin = true
    FROM _pd_start m
   WHERE a.source = 'git' AND NOT a.is_system AND NOT a.is_plugin
     AND a.skill_id IS NOT NULL
     AND a.actor_user_id = m.user_id AND a.created_at >= m.start_at
     AND NOT EXISTS (
       SELECT 1 FROM tokens t
        WHERE t.type = 'install' AND NOT t.is_system
          AND t.user_id = a.actor_user_id AND t.skill_id = a.skill_id
          AND t.used_at IS NOT NULL AND t.used_at <= a.created_at + interval '1 minute'
     );
  SELECT count(*) INTO v_flagged FROM access_log
   WHERE is_plugin AND (p_users IS NULL OR actor_user_id = ANY (p_users));

  -- 4. A ledger row whose first access-log row is flagged becomes DELIVERED ONLY. Rows first
  --    written by a download or an MCP read have no git row at first_at and stay adopted; a row
  --    adopted after it was first held (adopted_at > first_at) is left alone.
  UPDATE skill_installs si SET adopted_at = NULL
   WHERE si.adopted_at = si.first_at
     AND (p_users IS NULL OR si.user_id = ANY (p_users))
     AND EXISTS (
       SELECT 1 FROM access_log a
        WHERE a.actor_user_id = si.user_id AND a.skill_id = si.skill_id
          AND a.source = 'git' AND a.created_at = si.first_at AND a.is_plugin
     );
  GET DIAGNOSTICS v_reclassified = ROW_COUNT;

  -- 5. The maintainer credits of past deliveries go. No backup, by decision: who maintained the
  --    skill at that moment is stored only in these rows.
  DELETE FROM install_credits ic USING access_log a
   WHERE ic.access_log_id = a.id AND a.is_plugin
     AND (p_users IS NULL OR a.actor_user_id = ANY (p_users));
  GET DIAGNOSTICS v_credits = ROW_COUNT;

  -- 6. Later deliberate clones are recovered: for each delivered-only row, the earliest later
  --    unflagged personal git row (proven by an install token, step 3b) becomes the adoption,
  --    credited to the skill's CURRENT explicit maintainers other than the installer.
  DROP TABLE IF EXISTS pg_temp._pd_recovered;
  CREATE TEMP TABLE _pd_recovered ON COMMIT DROP AS
    SELECT DISTINCT ON (si.skill_id, si.user_id) si.skill_id, si.user_id, a.id AS access_id, a.created_at
      FROM skill_installs si
      JOIN access_log a ON a.actor_user_id = si.user_id AND a.skill_id = si.skill_id
                       AND a.source = 'git' AND NOT a.is_plugin AND NOT a.is_system
                       AND a.created_at > si.first_at
     WHERE si.adopted_at IS NULL AND (p_users IS NULL OR si.user_id = ANY (p_users))
     ORDER BY si.skill_id, si.user_id, a.created_at;
  UPDATE skill_installs si SET adopted_at = r.created_at
    FROM _pd_recovered r
   WHERE si.skill_id = r.skill_id AND si.user_id = r.user_id;
  GET DIAGNOSTICS v_recovered = ROW_COUNT;
  INSERT INTO install_credits (access_log_id, user_id)
  SELECT r.access_id, sm.user_id
    FROM _pd_recovered r
    JOIN skill_maintainers sm ON sm.skill_id = r.skill_id AND sm.user_id <> r.user_id
    JOIN users u ON u.id = sm.user_id AND u.status = 'active' AND u.erased_at IS NULL
  ON CONFLICT DO NOTHING;

  -- 7. One audit row with the four totals.
  v_totals := jsonb_build_object(
    'accessRowsFlagged', v_flagged, 'ledgerRowsReclassified', v_reclassified,
    'creditsRemoved', v_credits, 'adoptionsRecovered', v_recovered,
    'scope', CASE WHEN p_users IS NULL THEN 'all' ELSE 'users' END);
  INSERT INTO audit_log (actor_user_id, action, target_type, target_id, namespace_id, before, after, source, request_id)
  VALUES (NULL, 'leaderboard.plugin_recount', 'leaderboard', NULL, NULL, NULL, v_totals, 'worker', NULL);
  RETURN v_totals;
END;
$$;
REVOKE ALL ON FUNCTION recount_plugin_deliveries(uuid[]) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skilly_app') THEN
    REVOKE ALL ON FUNCTION recount_plugin_deliveries(uuid[]) FROM skilly_app;
  END IF;
END $$;

SELECT recount_plugin_deliveries();

-- From here on, a row written without an explicit adopted_at is a deliberate adoption; only the
-- plugin path writes NULL.
ALTER TABLE skill_installs ALTER COLUMN adopted_at SET DEFAULT now();

-- The board's count and §66's window read adopted rows per user.
CREATE INDEX IF NOT EXISTS idx_skill_installs_user_adopted ON skill_installs (user_id, adopted_at) WHERE adopted_at IS NOT NULL;

COMMIT;
