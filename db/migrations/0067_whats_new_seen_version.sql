-- What's new "seen" marker (SKILLY_SPEC.md §23, "What's new — release notes + the new-version toast").
-- The highest app version whose release notes the user has been shown (or been silently advanced
-- past). Nullable, deliberately NOT back-filled: on roll-out every existing, already-onboarded user
-- gets the new-version toast exactly once on their next page load. Brand-new users have it stamped
-- by the Quick start page together with onboarded_at, so they never see the toast for the version
-- they onboarded on. Only ever moves forward (the stamp endpoint refuses to regress it).
alter table users add column if not exists whats_new_seen_version text;
