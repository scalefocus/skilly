-- 0103: Search gaps — what people search for and don't find (SKILLY_SPEC.md §62).
--
--   search_gap_salts      one random salt per UTC day. A searcher is stored only as
--                         HMAC-SHA256(salt, user id); the housekeeping sweep deletes the salt once
--                         its day is folded, so hashes can't be linked across days (§62.2).
--   search_gap_hits       today's raw hits: one row per (day, query, surface, mode, searcher), with a
--                         repeat counter. No timestamp, serial id or user id, by design.
--   search_gap_daily      folded per-day counts (hits, distinct searchers); kept 90 days.
--   search_gaps           one row per query that crossed the admin threshold, with the AI draft and
--                         the admin's outcome (§62.3).
--   search_gap_tombstones the unsalted SHA-256 of every accepted or dismissed query: never recorded
--                         or suggested again (§62.1 #9).
--   skill_requests        requester becomes optional: a *Platform* request (origin 'search_gap') has
--                         none (§62.10).
--   idx_notifications_search_gaps_ready_unread  one unread coalesced `search_gaps.ready` per admin.
--
-- The `search_gaps_*` settings need no seed rows (absent ⇒ the §62.8 defaults; collection off).
-- Table grants come from the 0002 default privileges. Nothing here is audit data.
BEGIN;

CREATE TABLE IF NOT EXISTS search_gap_salts (
  day  DATE PRIMARY KEY,
  salt BYTEA NOT NULL CONSTRAINT search_gap_salts_len CHECK (octet_length(salt) = 32)
);

CREATE TABLE IF NOT EXISTS search_gap_hits (
  day           DATE NOT NULL,
  query_norm    TEXT NOT NULL CONSTRAINT search_gap_hits_query_check CHECK (char_length(query_norm) BETWEEN 1 AND 400),
  surface       TEXT NOT NULL CONSTRAINT search_gap_hits_surface_check CHECK (surface IN ('web', 'mcp')),
  mode          TEXT NOT NULL CONSTRAINT search_gap_hits_mode_check CHECK (mode IN ('none', 'any')),
  searcher_hash BYTEA NOT NULL,
  hits          INT NOT NULL DEFAULT 1,
  PRIMARY KEY (day, query_norm, surface, mode, searcher_hash)
);

CREATE TABLE IF NOT EXISTS search_gap_daily (
  day        DATE NOT NULL,
  query_norm TEXT NOT NULL,
  surface    TEXT NOT NULL CONSTRAINT search_gap_daily_surface_check CHECK (surface IN ('web', 'mcp')),
  mode       TEXT NOT NULL CONSTRAINT search_gap_daily_mode_check CHECK (mode IN ('none', 'any')),
  hits       INT NOT NULL,
  searchers  INT NOT NULL,
  PRIMARY KEY (day, query_norm, surface, mode)
);
-- Dismiss/accept delete a query's rows; the sweep sums a window per query.
CREATE INDEX IF NOT EXISTS idx_search_gap_daily_query ON search_gap_daily (query_norm, day);

CREATE TABLE IF NOT EXISTS search_gaps (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_norm               TEXT NOT NULL UNIQUE,
  query_hash               BYTEA NOT NULL UNIQUE,
  mode                     TEXT NOT NULL CONSTRAINT search_gaps_mode_check CHECK (mode IN ('none', 'any')),
  surfaces                 TEXT[] NOT NULL DEFAULT '{}',
  hits                     INT NOT NULL DEFAULT 0,
  searchers                INT NOT NULL DEFAULT 0,
  first_day                DATE NOT NULL,
  last_day                 DATE NOT NULL,
  state                    TEXT NOT NULL DEFAULT 'new'
                           CONSTRAINT search_gaps_state_check CHECK (state IN ('new', 'suggested', 'failed', 'accepted')),
  restricted_matches       JSONB NOT NULL DEFAULT '[]',
  ai_kind                  TEXT CONSTRAINT search_gaps_ai_kind_check CHECK (ai_kind IS NULL OR ai_kind IN ('synonym', 'request', 'noise')),
  ai_draft                 JSONB,
  ai_model                 TEXT,
  ai_attempts              INT NOT NULL DEFAULT 0,
  ai_last_error            TEXT,
  ai_next_attempt_at       TIMESTAMPTZ,
  outcome                  TEXT CONSTRAINT search_gaps_outcome_check CHECK (outcome IS NULL OR outcome IN ('request', 'synonym')),
  outcome_request_id       UUID REFERENCES skill_requests(id) ON DELETE SET NULL,
  outcome_synonym_group_id UUID REFERENCES search_synonym_groups(id) ON DELETE SET NULL,
  decided_by_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT search_gaps_outcome_accepted CHECK ((state = 'accepted') = (outcome IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_search_gaps_state ON search_gaps (state, searchers DESC);

CREATE TABLE IF NOT EXISTS search_gap_tombstones (
  query_hash BYTEA PRIMARY KEY,
  outcome    TEXT NOT NULL CONSTRAINT search_gap_tombstones_outcome_check CHECK (outcome IN ('request', 'synonym', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE skill_requests ALTER COLUMN requester_user_id DROP NOT NULL;
ALTER TABLE skill_requests ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'user'
  CONSTRAINT skill_requests_origin_check CHECK (origin IN ('user', 'search_gap'));
ALTER TABLE skill_requests DROP CONSTRAINT IF EXISTS skill_requests_origin_requester;
ALTER TABLE skill_requests ADD CONSTRAINT skill_requests_origin_requester
  CHECK ((origin = 'user') = (requester_user_id IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_search_gaps_ready_unread
  ON notifications (user_id) WHERE type = 'search_gaps.ready' AND read_at IS NULL;

COMMIT;
