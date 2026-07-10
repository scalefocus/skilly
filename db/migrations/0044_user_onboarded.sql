-- First-login onboarding: record when a user has seen the Quick start page, so the app shows it
-- once on first login and never forces it again afterward (SKILLY_SPEC.md §8 / Quick start).
-- Nullable + NO backfill — a null marker means "hasn't seen it yet", so on the next login EVERY
-- existing user is taken through Quick start once (the deliberate roll-out choice), then stamped.
-- The page stamps onboarded_at = now() the moment it is viewed (POST /api/me/onboarded), so the
-- global redirect gate releases immediately and navigating away never loops back.
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;
