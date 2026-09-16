-- §32 Real user monitoring (RUM): client-side performance + error telemetry, aggregated per route
-- for platform admins. Operational telemetry like system_event (§25) — NOT audit: mutable tables,
-- cheap inserts, bounded retention, no hash chain, no append-only trigger.
--
--   rum_samples  raw browser samples, 30-day retention (worker housekeeping prunes them).
--                `route` is ALWAYS a template from the known-route table (or the literal 'other')
--                — never a concrete path, never a query string (invariant #6). `created_at` is
--                server-stamped; the client sends no timestamps. `user_id` is nullable + SET NULL
--                so GDPR erasure (§4) keeps the row and only drops the person.
--   rum_errors   the client-error fingerprint index (sha256 over type + normalised message + top
--                frame — route is NOT part of it, so one bug on three pages is one row). Upserted
--                per occurrence; rows idle > 90 days are pruned.
--   rum_daily    the per-(day, route) rollup, written hourly by a leader-only worker sweep for
--                today + yesterday (UTC) and kept indefinitely. Carries an explicit 'all' route row
--                (true p75 over every sample that day) so the platform-wide numbers for the 90d/All
--                ranges are exact rather than a mean of per-route percentiles.
--
-- (Table-level grants for skilly_app are inherited from the default privileges set in 0002.)
BEGIN;

CREATE TABLE IF NOT EXISTS rum_samples (
  id          bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  session_id  text NOT NULL CHECK (char_length(session_id) BETWEEN 8 AND 64),
  route       text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('page_view', 'vital', 'nav', 'api', 'error')),
  name        text,
  value       double precision CHECK (value IS NULL OR (value >= 0 AND value <= 60000)),
  ok          boolean
);
CREATE INDEX IF NOT EXISTS rum_samples_route_created_idx ON rum_samples (route, created_at);
CREATE INDEX IF NOT EXISTS rum_samples_created_idx       ON rum_samples (created_at);
CREATE INDEX IF NOT EXISTS rum_samples_user_idx          ON rum_samples (user_id);
CREATE INDEX IF NOT EXISTS rum_samples_kind_name_created_idx ON rum_samples (kind, name, created_at);

CREATE TABLE IF NOT EXISTS rum_errors (
  fingerprint text PRIMARY KEY CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  type        text NOT NULL,
  message     text NOT NULL CHECK (char_length(message) <= 500),
  frame       text NOT NULL DEFAULT '' CHECK (char_length(frame) <= 300),
  count       integer NOT NULL DEFAULT 0,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rum_errors_last_seen_idx ON rum_errors (last_seen);

CREATE TABLE IF NOT EXISTS rum_daily (
  day         date NOT NULL,
  route       text NOT NULL,
  views       integer NOT NULL DEFAULT 0,
  sessions    integer NOT NULL DEFAULT 0,
  lcp_p75     double precision,
  inp_p75     double precision,
  cls_p75     double precision,
  ttfb_p75    double precision,
  nav_p75     double precision,
  api_p75     double precision,
  api_calls   integer NOT NULL DEFAULT 0,
  api_errors  integer NOT NULL DEFAULT 0,
  errors      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, route)
);

COMMIT;
