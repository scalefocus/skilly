-- Feedback survey (SKILLY_SPEC.md §36).
--
--   user_feature_uses     the per-user first-use ledger behind the survey trigger (§36.1). A fresh
--                         insert is a first use; it is personal data, deleted on GDPR erasure.
--   users.surveys_enabled / survey_last_shown_at / survey_offer
--                         the opt-out, the 30-day floor's stamp and the currently open offer.
--   survey_responses      ANONYMOUS by construction: no user column and no time of day, only the
--   survey_answers        UTC date (§36.12). Immutable — the only delete is an audited admin one.
--   survey_daily          aggregate funnel counters with no user or feature dimension.
--
-- Backfill (§36.13): first uses are reconstructed from existing history where it exists, and every
-- existing onboarded user gets a random "last surveyed" stamp within the past 30 days, so the first
-- surveys spread over the month after release instead of landing on everyone on day one.
BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS surveys_enabled      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS survey_last_shown_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS survey_offer         JSONB;

CREATE TABLE IF NOT EXISTS user_feature_uses (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature       TEXT NOT NULL,
  first_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature)
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  answered_on     DATE NOT NULL,
  catalog_version INT  NOT NULL,
  trigger         TEXT NOT NULL CHECK (trigger IN ('feature', 'visit')),
  feature         TEXT,
  segment         TEXT NOT NULL CHECK (segment IN ('consumer', 'maintainer', 'admin')),
  via             TEXT NOT NULL CHECK (via IN ('popup', 'menu')),
  free_text       TEXT CHECK (free_text IS NULL OR char_length(free_text) <= 2000)
);
CREATE INDEX IF NOT EXISTS idx_survey_responses_answered_on ON survey_responses (answered_on);

CREATE TABLE IF NOT EXISTS survey_answers (
  response_id  UUID     NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
  question_key TEXT     NOT NULL,
  stars        SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  PRIMARY KEY (response_id, question_key)
);

CREATE TABLE IF NOT EXISTS survey_daily (
  day                 DATE PRIMARY KEY,
  shown               INT NOT NULL DEFAULT 0,
  closed              INT NOT NULL DEFAULT 0,
  submitted           INT NOT NULL DEFAULT 0,
  submitted_from_menu INT NOT NULL DEFAULT 0
);

-- Grants come from the 0002 default privileges. Responses are immutable (no UPDATE path); the
-- ledger is only ever inserted or erased; the funnel counters are the only UPDATEd survey table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skilly_app') THEN
    REVOKE UPDATE ON user_feature_uses FROM skilly_app;
    REVOKE UPDATE ON survey_responses FROM skilly_app;
    REVOKE UPDATE ON survey_answers FROM skilly_app;
    REVOKE DELETE ON survey_daily FROM skilly_app;
  END IF;
END
$$;

-- ---- Backfill the first-use ledger from existing history (§36.13) -------------------------------
-- The earliest known timestamp per user × feature. search / marketplaces / achievements /
-- leaderboard leave no per-user trace and start empty.
INSERT INTO user_feature_uses (user_id, feature, first_used_at)
SELECT user_id, feature, min(at) FROM (
  SELECT user_id, 'install' AS feature, created_at AS at FROM tokens WHERE type = 'install'
  UNION ALL SELECT user_id, 'install', first_at FROM skill_downloads
  UNION ALL SELECT actor_user_id, 'install', created_at FROM access_log WHERE actor_user_id IS NOT NULL
  UNION ALL SELECT submitted_by, 'propose', created_at FROM proposals
  UNION ALL SELECT actor_user_id, 'review', created_at FROM audit_log
    WHERE actor_user_id IS NOT NULL AND action IN ('proposal.accept', 'proposal.reject', 'proposal.request_changes')
  UNION ALL SELECT requester_user_id, 'request', created_at FROM skill_requests
  UNION ALL SELECT author_id, 'messaging', created_at FROM messages
  UNION ALL SELECT user_id, 'mcp', created_at FROM oauth_grants
  UNION ALL SELECT user_id, 'rating', created_at FROM skill_ratings
  UNION ALL SELECT created_by, 'share_link', created_at FROM skill_share_links WHERE created_by IS NOT NULL
  UNION ALL SELECT follower_id, 'follow', created_at FROM user_follows
) h
WHERE user_id IN (SELECT id FROM users WHERE erased_at IS NULL)
GROUP BY user_id, feature
ON CONFLICT DO NOTHING;

-- ---- Stagger the launch (§36.13) --------------------------------------------------------------
-- Each existing onboarded, active user's first 30-day window ends at a random point over the next
-- month. These stamps are not "shown" in the funnel: survey_daily starts empty.
UPDATE users
   SET survey_last_shown_at = now() - random() * interval '30 days'
 WHERE onboarded_at IS NOT NULL AND status = 'active' AND erased_at IS NULL AND survey_last_shown_at IS NULL;

INSERT INTO platform_settings (key, value, updated_at)
VALUES ('survey_enabled', 'true'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

COMMIT;
