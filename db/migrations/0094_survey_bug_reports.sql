-- Bug reports: the sidebar's bug button (SKILLY_SPEC.md §36.17).
--
--   survey_responses.trigger     gains 'bug'. A bug report is an anonymous response with no star
--                                answers, a required description (free_text) and no feature.
--   survey_responses.page_path   the page the reporter was on (pathname only, never a query string
--                                or fragment), ≤ 512 chars. Bug reports only.
--   survey_responses.app_version the server's APP_VERSION at submit time. Bug reports only.
--   survey_daily.submitted_bug   bug reports submitted, kept apart from the survey funnels.
--   platform_settings            bug_reports_enabled, default on.
--
-- No grant changes: the 0079 grants cover the new columns.
BEGIN;

ALTER TABLE survey_responses
  ADD COLUMN IF NOT EXISTS page_path   TEXT,
  ADD COLUMN IF NOT EXISTS app_version TEXT;

ALTER TABLE survey_responses DROP CONSTRAINT IF EXISTS survey_responses_trigger_check;
ALTER TABLE survey_responses
  ADD CONSTRAINT survey_responses_trigger_check CHECK (trigger IN ('feature', 'visit', 'self', 'bug'));

ALTER TABLE survey_responses DROP CONSTRAINT IF EXISTS survey_responses_page_path_len;
ALTER TABLE survey_responses
  ADD CONSTRAINT survey_responses_page_path_len CHECK (char_length(page_path) <= 512);

-- A bug report always has its description and never a feature; only a bug report has a path or version.
ALTER TABLE survey_responses DROP CONSTRAINT IF EXISTS survey_responses_bug_shape;
ALTER TABLE survey_responses
  ADD CONSTRAINT survey_responses_bug_shape CHECK (
    (trigger <> 'bug' OR (free_text IS NOT NULL AND feature IS NULL))
    AND (trigger = 'bug' OR (page_path IS NULL AND app_version IS NULL))
  );

ALTER TABLE survey_daily
  ADD COLUMN IF NOT EXISTS submitted_bug INT NOT NULL DEFAULT 0;

INSERT INTO platform_settings (key, value, updated_at)
VALUES ('bug_reports_enabled', 'true'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

COMMIT;
