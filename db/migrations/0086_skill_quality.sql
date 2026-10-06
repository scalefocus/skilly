-- Skill quality rating (SKILLY_SPEC.md §41).
--
--   skill_version_quality      one row per scored version: the rules score (from the artifact's
--                              latest scan report, scanner `quality`), the AI part (status,
--                              score, model, verdict, attempt bookkeeping), the blended final
--                              score and mode, and the once-per-assessment low-score notification
--                              guard. Findings are NOT duplicated here — they live in scan_reports.
--   skills.quality_score       the latest stable active version's final score, denormalized for
--   skills.quality_mode        catalog sort / facet / tiebreak (§41.6; refreshed by code, not trigger).
--   users.quality_notifications  the Profile opt-out for skill.quality_low (§41.9).
--
-- No backfill: the worker's quality sweep (§41.6) scores every published version after deploy.
BEGIN;

CREATE TABLE IF NOT EXISTS skill_version_quality (
  skill_version_id     UUID PRIMARY KEY REFERENCES skill_versions(id) ON DELETE CASCADE,
  skill_id             UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  ruleset              INTEGER NOT NULL,
  rules_score          SMALLINT NOT NULL CHECK (rules_score BETWEEN 0 AND 100),
  ai_status            TEXT NOT NULL DEFAULT 'off' CHECK (ai_status IN ('off', 'pending', 'done', 'failed')),
  ai_score             SMALLINT CHECK (ai_score IS NULL OR ai_score BETWEEN 0 AND 100),
  ai_model             TEXT,
  ai_verdict           JSONB,
  ai_attempts          SMALLINT NOT NULL DEFAULT 0,
  ai_last_error        TEXT,
  ai_next_attempt_at   TIMESTAMPTZ,
  final_score          SMALLINT NOT NULL CHECK (final_score BETWEEN 0 AND 100),
  mode                 TEXT NOT NULL DEFAULT 'rules' CHECK (mode IN ('rules', 'rules+ai')),
  low_notified_at      TIMESTAMPTZ,
  rescore_requested_at TIMESTAMPTZ,
  scored_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skill_version_quality_ai ON skill_version_quality (ai_status, ai_next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_skill_version_quality_skill ON skill_version_quality (skill_id);

ALTER TABLE skills ADD COLUMN IF NOT EXISTS quality_score SMALLINT CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 100);
ALTER TABLE skills ADD COLUMN IF NOT EXISTS quality_mode TEXT CHECK (quality_mode IS NULL OR quality_mode IN ('rules', 'rules+ai'));
CREATE INDEX IF NOT EXISTS idx_skills_quality_score ON skills (quality_score DESC NULLS LAST);

ALTER TABLE users ADD COLUMN IF NOT EXISTS quality_notifications BOOLEAN NOT NULL DEFAULT true;

COMMIT;
