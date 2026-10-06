-- AI-drafted quality improvements (SKILLY_SPEC.md §43.8).
--
--   proposals.ai_draft_model   the model that drafted the submitted files through the §43 AI task,
--                              set once at creation from a valid `aiDraftToken` and never changed
--                              or cleared afterwards (revise, resubmit and reviewer edits keep it).
--                              NULL = not AI-drafted. Drives the reviewer-facing "Drafted with …"
--                              badge.
--
-- No backfill: no proposal before this change was AI-drafted. The §40.14 display name is a plain
-- platform_settings key (`ai_display_name`) and needs no schema change.
BEGIN;

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS ai_draft_model TEXT;

COMMIT;
