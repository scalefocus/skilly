-- 0109: Usage insights — how often a skill is used, not only installed (SKILLY_SPEC.md §68).
--
--   usage_report_keys        one row per user who shares usage: the SHA-256 of their usage key,
--                            read by the hook skilly ships in every marketplace plugin (§68.4).
--                            No expiry; deleted by Stop sharing and by GDPR erasure (§4).
--   skill_usage_salts        one random salt per UTC day (the §62 model). A reporter is stored only
--                            as HMAC-SHA256(salt, user id); the housekeeping sweep deletes the salt
--                            once its day is folded, so hashes can't be linked across days.
--   skill_usage_hits         today's raw uses: one row per (day, skill, version, trigger, reporter,
--                            event). No timestamp, no user id, no session, no IP — by design (§68.5).
--                            A second report of the same event (a skill carried by two installed
--                            plugins) conflicts on the PK and is a duplicate.
--   skill_usage_daily        folded per skill and day: uses + distinct people. Kept forever (§68.6).
--   skill_usage_daily_detail folded per skill, version, trigger and day: uses only — people are
--                            not kept at this grain (a person on two versions would count twice).
--
-- `usage_insights_enabled` needs no seed row (absent ⇒ false, §68.8). Table grants come from the
-- 0002 default privileges. Nothing here is audit data.
BEGIN;

CREATE TABLE IF NOT EXISTS usage_report_keys (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  key_hash     BYTEA NOT NULL UNIQUE CONSTRAINT usage_report_keys_hash_len CHECK (octet_length(key_hash) = 32),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS skill_usage_salts (
  day  DATE PRIMARY KEY,
  salt BYTEA NOT NULL CONSTRAINT skill_usage_salts_len CHECK (octet_length(salt) = 32)
);

CREATE TABLE IF NOT EXISTS skill_usage_hits (
  day           DATE NOT NULL,
  skill_id      UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  semver        TEXT NOT NULL CONSTRAINT skill_usage_hits_semver_check CHECK (char_length(semver) BETWEEN 1 AND 64),
  trigger       TEXT NOT NULL CONSTRAINT skill_usage_hits_trigger_check CHECK (trigger IN ('user', 'model')),
  reporter_hash BYTEA NOT NULL,
  event_hash    BYTEA NOT NULL,
  PRIMARY KEY (day, skill_id, semver, trigger, reporter_hash, event_hash)
);

-- Today's live counts are read per skill (the dashboard) and per day (the fold).
CREATE INDEX IF NOT EXISTS skill_usage_hits_skill_idx ON skill_usage_hits (skill_id, day);

CREATE TABLE IF NOT EXISTS skill_usage_daily (
  day      DATE NOT NULL,
  skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  uses     INT NOT NULL,
  people   INT NOT NULL,
  PRIMARY KEY (day, skill_id)
);

CREATE INDEX IF NOT EXISTS skill_usage_daily_skill_idx ON skill_usage_daily (skill_id, day);

CREATE TABLE IF NOT EXISTS skill_usage_daily_detail (
  day      DATE NOT NULL,
  skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  semver   TEXT NOT NULL,
  trigger  TEXT NOT NULL CONSTRAINT skill_usage_daily_detail_trigger_check CHECK (trigger IN ('user', 'model')),
  uses     INT NOT NULL,
  PRIMARY KEY (day, skill_id, semver, trigger)
);

CREATE INDEX IF NOT EXISTS skill_usage_daily_detail_skill_idx ON skill_usage_daily_detail (skill_id, day);

COMMIT;
