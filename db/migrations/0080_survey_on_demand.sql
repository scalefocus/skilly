-- On-demand feedback: "Give feedback now" (SKILLY_SPEC.md §36.16).
--
--   users.survey_self_shown_at   when the user last OPENED an on-demand survey; drives its 7-day
--                                cooldown. Stamped on open, never on submit, so it says nothing
--                                about whether or when they answered (§36.12). No backfill.
--   survey_daily.shown_self / submitted_self
--                                the on-demand funnel, kept apart from the random prompt's counters.
--   survey_responses.trigger     gains 'self'.
--
-- No grant changes: the 0079 grants cover the new columns.
BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS survey_self_shown_at TIMESTAMPTZ;

ALTER TABLE survey_daily
  ADD COLUMN IF NOT EXISTS shown_self     INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS submitted_self INT NOT NULL DEFAULT 0;

ALTER TABLE survey_responses DROP CONSTRAINT IF EXISTS survey_responses_trigger_check;
ALTER TABLE survey_responses
  ADD CONSTRAINT survey_responses_trigger_check CHECK (trigger IN ('feature', 'visit', 'self'));

COMMIT;
