-- Daily active-user history (SKILLY_SPEC.md §4), for the trend chart above the DAU/WAU/MAU
-- counters on Administration. One row per UTC calendar day, written by a leader-only worker
-- sweep that runs once a day: count(*) of status='active' users with last_seen within the
-- trailing 25 hours (a 1h buffer over 24h so a slightly-late run still catches a full day),
-- upserted on `day` so a re-run or restart the same day never double-counts. No back-fill is
-- possible or attempted — last_seen only ever holds each user's MOST RECENT activity, not a
-- log, so there is no way to reconstruct how many were active on a past day before this table
-- existed. Tiny (365 rows/year) — no retention/pruning needed.
CREATE TABLE IF NOT EXISTS daily_active_users (
  day   DATE PRIMARY KEY,
  count INTEGER NOT NULL
);
