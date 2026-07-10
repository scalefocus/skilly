-- Org-wide date/time display style (platform setting). 'eu' = dd/mm/yyyy + 24-hour clock,
-- 'us' = mm/dd/yyyy + 12-hour AM/PM. Timestamps remain stored as UTC (timestamptz); this
-- only governs how they are rendered, in each viewer's own timezone. Managed by platform
-- admins; changes are audit-logged. §4.
BEGIN;

INSERT INTO platform_settings (key, value) VALUES ('date_format', '"eu"'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
