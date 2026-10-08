-- AI pre-review of proposals (SKILLY_SPEC.md §46).
--
--   ai_prereviews              one row per RUN: one LLM review of one set of bytes. Keyed for reuse
--                              by (content_sha256, prompt_version) — content_sha256 stays null until
--                              the worker has the files (a pointer clone). `source` says where the
--                              bytes come from (an artifact object key, or a pointer url/ref/subdir);
--                              never credentials. `result` is the VALIDATED model output (derived
--                              skill content — served only behind the subject's own visibility gate);
--                              the prompt and the raw response are never stored (§40.12).
--                              Deliberately NOT scan_reports: nothing that gates reads this table.
--   ai_prereview_links         which run covers which subject — a proposal revision OR a skill
--                              version. A subject's newest link is its current run; a re-run adds
--                              one. `cached` marks a link that reused an existing run (no new call).
--   ai_prereview_dispositions  Agree / Dismiss per finding fingerprint, keyed to a proposal (all its
--                              revisions) OR a version. Append-only for the app role: the newest row
--                              per fingerprint counts.
--   skill_versions.ai_prereview_notified_at   the once-per-version guard of skill.ai_prereview_flagged.
--   users.ai_prereview_notifications          the Profile opt-out for that notification.
--
-- The on/off switch is the `ai_prereview_enabled` platform setting (no column). No backfill: the
-- system never reviews published versions retroactively (§46.2).
BEGIN;

CREATE TABLE IF NOT EXISTS ai_prereviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  content_sha256  TEXT,
  prompt_version  INTEGER NOT NULL,
  source          JSONB NOT NULL,
  trigger         TEXT NOT NULL CHECK (trigger IN ('submit', 'revision', 'enable', 'direct_publish', 'mirror', 'rerun')),
  requested_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  attempts        SMALLINT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_error      TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  model           TEXT,
  result          JSONB,
  coverage        JSONB,
  max_severity    TEXT CHECK (max_severity IS NULL OR max_severity IN ('low', 'medium', 'high', 'critical')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_prereviews_due ON ai_prereviews (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_ai_prereviews_cache ON ai_prereviews (content_sha256, prompt_version, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_prereview_links (
  id                BIGSERIAL PRIMARY KEY,
  run_id            UUID NOT NULL REFERENCES ai_prereviews(id) ON DELETE CASCADE,
  proposal_id       UUID REFERENCES proposals(id) ON DELETE CASCADE,
  revision          INTEGER,
  skill_version_id  UUID REFERENCES skill_versions(id) ON DELETE CASCADE,
  cached            BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_prereview_links_one_subject CHECK (
    (proposal_id IS NOT NULL AND revision IS NOT NULL AND skill_version_id IS NULL)
    OR (proposal_id IS NULL AND revision IS NULL AND skill_version_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_prereview_links_proposal ON ai_prereview_links (proposal_id, revision, id DESC) WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_prereview_links_version ON ai_prereview_links (skill_version_id, id DESC) WHERE skill_version_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_prereview_links_run ON ai_prereview_links (run_id);

CREATE TABLE IF NOT EXISTS ai_prereview_dispositions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id       UUID REFERENCES proposals(id) ON DELETE CASCADE,
  skill_version_id  UUID REFERENCES skill_versions(id) ON DELETE CASCADE,
  fingerprint       TEXT NOT NULL,
  verdict           TEXT NOT NULL CHECK (verdict IN ('agree', 'dismiss')),
  reason            TEXT CHECK (reason IS NULL OR char_length(reason) <= 500),
  decided_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_prereview_dispositions_one_subject CHECK ((proposal_id IS NULL) <> (skill_version_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_ai_prereview_disp_proposal ON ai_prereview_dispositions (proposal_id, fingerprint) WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_prereview_disp_version ON ai_prereview_dispositions (skill_version_id, fingerprint) WHERE skill_version_id IS NOT NULL;

ALTER TABLE skill_versions ADD COLUMN IF NOT EXISTS ai_prereview_notified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_prereview_notifications BOOLEAN NOT NULL DEFAULT true;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skilly_app') THEN
    REVOKE UPDATE, DELETE ON ai_prereview_dispositions FROM skilly_app;
  END IF;
END
$$;

COMMIT;
