-- Per-user date/time format override (profile preference). NULL = follow the platform default
-- set by the global admin (platform_settings.date_format); 'eu'/'us' override it for this user.
-- SKILLY_SPEC.md §4/§12.
BEGIN;

ALTER TABLE users ADD COLUMN date_format TEXT
  CHECK (date_format IN ('eu', 'us'));

COMMIT;
