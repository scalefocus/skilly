-- System log (SKILLY_SPEC.md §25): operational telemetry of user-facing HTTP error
-- responses from the web tier — the issues the platform encountered (5XX, plus the
-- meaningful 4XX: 403/409/422/429), with the user who hit them. Platform-admin only.
--
-- This is NOT audit_log: it is high-volume, mutable operational telemetry, so it has NO
-- tamper-evident hash chain and NO append-only trigger (cheap inserts, easy retention trim).
-- Privacy: we store the matched route TEMPLATE + the concrete path only — never the query
-- string, request body, headers, or a stack trace (CLAUDE.md #6; query strings can carry
-- tokens/PII). 500 detail is a sanitized one-liner.
BEGIN;

-- pg_trgm powers fast substring (ILIKE '%term%') search over the event blob below.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE system_event (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status      SMALLINT NOT NULL,                       -- HTTP status (403, 422, 500, …)
  method      TEXT NOT NULL,                            -- GET/POST/…
  route       TEXT NOT NULL,                            -- matched template, e.g. /api/skills/[ns]/[slug]
  path        TEXT NOT NULL,                            -- concrete path hit (NO query string)
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,  -- null when unauthenticated
  -- Point-in-time snapshot of who hit it, denormalized at insert (correlated subquery, no extra
  -- round-trip). Keeps the search blob fully local so the trigram index below actually applies,
  -- and is the correct model for a log: a later rename doesn't rewrite history. (CLAUDE.md
  -- accepted assumption: logs retain actor PII for provenance.)
  actor_name  TEXT,
  actor_email TEXT,
  error_code  TEXT,                                     -- the {error:"…"} string we already return
  message     TEXT,                                     -- short sanitized detail (truncated at write)
  request_id  TEXT,                                     -- x-request-id if the edge set one
  duration_ms INTEGER,
  -- web for v1; the enum-ish column lets the worker contribute later without a migration.
  source      TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'worker'))
);

-- Newest-first listing (the default view + every paginated scroll).
CREATE INDEX idx_system_event_created ON system_event (created_at DESC);
-- Status-class filter chips (5XX / 403 / 422 / 429) combined with the created_at order.
CREATE INDEX idx_system_event_status ON system_event (status, created_at DESC);
-- Pivot "everything this user hit" (clicking a user filters by their id).
CREATE INDEX idx_system_event_user ON system_event (user_id, created_at DESC);

-- Trigram GIN over the searchable blob of this table's OWN columns. Because actor identity is
-- denormalized above, the blob is fully local — the /api/system-log query ANDs the active status
-- chip with a single ILIKE over THIS EXACT expression, so the planner uses this index (no cross-
-- table OR to defeat it). Keep the expression byte-identical in lib/systemLog.ts.
CREATE INDEX idx_system_event_search ON system_event USING gin (
  (coalesce(path, '') || ' ' || coalesce(error_code, '') || ' ' || coalesce(message, '') || ' ' ||
   coalesce(user_id::text, '') || ' ' || coalesce(actor_email, '') || ' ' || coalesce(actor_name, '')) gin_trgm_ops
);

-- skilly_app inherits SELECT/INSERT/UPDATE/DELETE from the default privileges set in 0002;
-- the uuid PK has no sequence, so no extra sequence grant is needed (unlike usage_events).

COMMIT;
