-- 0027: performance pass — indexes, watcher-count denormalization, trigram autocomplete.
-- Pure additive DDL (no data semantics change). Addresses the hot read/scan paths surfaced by
-- the performance audit: leaderboard, usage dashboard, install rollups, catalog search/facets,
-- review queue, nav badges, audit chain, and the worker sweeps.

-- access_log is the highest-volume table (one row per git clone). Every install rollup,
-- the leaderboard, and the usage dashboard filter source='git' [+ skill_id] [+ created_at];
-- only skill_id was indexed. A partial composite serves the per-skill grouped installs, and a
-- (source, created_at) index serves the platform-wide / windowed aggregates.
CREATE INDEX IF NOT EXISTS idx_access_log_skill_source_created ON access_log (skill_id, source, created_at) WHERE source = 'git';
CREATE INDEX IF NOT EXISTS idx_access_log_source_created ON access_log (source, created_at);

-- proposals: "My Skills" EXISTS (submitted_by), leaderboard CTE, review queue + nav badges
-- (state/created_at, scoped by namespace).
CREATE INDEX IF NOT EXISTS idx_proposals_submitted_by ON proposals (submitted_by);
CREATE INDEX IF NOT EXISTS idx_proposals_state_created ON proposals (state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proposals_ns_created ON proposals (target_namespace_id, created_at DESC);

-- skill_versions: max(created_at) "last updated", latest-version lookups, and worker sweeps.
CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_created ON skill_versions (skill_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_versions_yanked_published ON skill_versions (skill_id) WHERE status = 'yanked' AND git_published = true;
CREATE INDEX IF NOT EXISTS idx_skill_versions_active_published ON skill_versions (skill_id) WHERE status = 'active' AND git_published = true;

-- scan_reports: the pointer-refresh "latest scan" anti-join had no supporting index at all.
CREATE INDEX IF NOT EXISTS idx_scan_reports_subject ON scan_reports (subject_type, subject_id, created_at DESC);

-- audit_log: the insert trigger reads max(seq) on every write; verify/rebaseline walk seq asc;
-- trim + viewer pagination filter/sort by created_at. seq was unindexed (BIGSERIAL only makes a
-- sequence), created_at was unindexed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_seq ON audit_log (seq);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);

-- notifications: the unread badge count.
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (user_id) WHERE read_at IS NULL;

-- catalog facets + active-visible scans: status/visibility/tool_harness/type GROUP BY.
CREATE INDEX IF NOT EXISTS idx_skills_active_facets ON skills (status, visibility, tool_harness, type) WHERE status = 'active';

-- Trigram indexes so the header autocomplete (substring ILIKE on title/slug) is index-backed
-- instead of a per-keystroke sequential scan. pg_trgm is a trusted extension (PG13+), creatable
-- by the database owner.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_skills_title_trgm ON skills USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_skills_slug_trgm  ON skills USING gin (slug  gin_trgm_ops);

-- Denormalize the watcher count onto skills (same rollup pattern as rating_sum/install_count)
-- so the catalog search no longer runs a correlated count(*) subquery per result row.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS watcher_count INTEGER NOT NULL DEFAULT 0;
UPDATE skills s SET watcher_count = (SELECT count(*) FROM skill_watches sw WHERE sw.skill_id = s.id);

CREATE OR REPLACE FUNCTION skill_watch_rollup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE skills SET watcher_count = watcher_count + 1 WHERE id = NEW.skill_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE skills SET watcher_count = GREATEST(watcher_count - 1, 0) WHERE id = OLD.skill_id;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_skill_watch_rollup ON skill_watches;
CREATE TRIGGER trg_skill_watch_rollup AFTER INSERT OR DELETE ON skill_watches
  FOR EACH ROW EXECUTE FUNCTION skill_watch_rollup();
