-- Monthly install totals for the overview stat (SKILLY_SPEC.md §10).
-- A pure increment-on-install counter (one row per calendar month) so the overview
-- page reads ONE indexed row instead of counting access_log per request — page
-- reloads can't be used to hammer an aggregate query (DoS-safe by construction).
-- The git gateway (worker logAccess) upserts the current month's row on every fetch.
-- (Table-level grants for skilly_app are inherited from the default privileges in 0002.)
BEGIN;

CREATE TABLE install_counters (
  month DATE   PRIMARY KEY,   -- first day of the calendar month
  total BIGINT NOT NULL DEFAULT 0
);

-- Backfill from the existing install provenance (every git fetch is one install).
INSERT INTO install_counters (month, total)
SELECT date_trunc('month', created_at)::date, count(*)
  FROM access_log
 WHERE source = 'git'
 GROUP BY 1;

COMMIT;
