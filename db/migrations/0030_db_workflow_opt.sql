-- 0030: DB workflow optimizations.
--   (a) record_git_access() — the git gateway logs every clone with THREE separate writes
--       (access_log insert + skills.install_count bump + install_counters upsert). On the hottest
--       path that's 3 round-trips per clone; fold them into one SQL function = one round-trip,
--       executed atomically. SECURITY INVOKER (default) so the app role's grants still apply.
--   (b) Cover the foreign keys that are actually joined or cascade-deleted on GROWTH tables
--       (proposals, proposal_revisions, skill_maintainers, usage_events). The remaining unindexed
--       FKs are intentionally left alone: tiny lookup tables (role_mappings, platform_settings),
--       an always-NULL column (access_log.skill_version_id — the gateway writes NULL), or columns
--       reachable via an existing better index — indexing those would only add write cost.

-- (a) one-call install recorder for the gateway hot path.
CREATE OR REPLACE FUNCTION record_git_access(p_skill_id uuid, p_user_id uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO access_log (actor_user_id, skill_id, skill_version_id, source)
  VALUES (p_user_id, p_skill_id, NULL, 'git');

  UPDATE skills SET install_count = install_count + 1 WHERE id = p_skill_id;

  INSERT INTO install_counters (month, total)
  VALUES (date_trunc('month', now())::date, 1)
  ON CONFLICT (month) DO UPDATE SET total = install_counters.total + 1;
$$;

-- (b) FK indexes on growth tables (joins + cascade-on-delete).
CREATE INDEX IF NOT EXISTS idx_proposals_target_skill        ON proposals (target_skill_id);
CREATE INDEX IF NOT EXISTS idx_proposals_materialized_version ON proposals (materialized_version_id);
CREATE INDEX IF NOT EXISTS idx_proposal_revisions_author      ON proposal_revisions (author);
CREATE INDEX IF NOT EXISTS idx_skill_maintainers_added_by     ON skill_maintainers (added_by);
CREATE INDEX IF NOT EXISTS idx_usage_events_actor             ON usage_events (actor_user_id);
