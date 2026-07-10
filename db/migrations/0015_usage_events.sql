-- Usage analytics (SKILLY_SPEC.md §21): append-only log of authenticated skill-detail VIEWS.
-- Installs are NOT duplicated here — they're derived from access_log (the git clone). Views
-- are written fire-and-forget by the detail route AFTER the visibility check, so a row can
-- never itself be a leak. namespace_id is denormalized for the per-namespace aggregate.
-- (Table-level grants for skilly_app are inherited from the default privileges in 0002.)
BEGIN;

CREATE TABLE usage_events (
  id            BIGSERIAL PRIMARY KEY,
  skill_id      UUID NOT NULL REFERENCES skills(id)     ON DELETE CASCADE,
  namespace_id  UUID NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id)               ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Time-bucketed aggregation by skill (dashboard rows) and by namespace (namespace aggregate).
CREATE INDEX idx_usage_events_skill ON usage_events(skill_id, created_at);
CREATE INDEX idx_usage_events_ns    ON usage_events(namespace_id, created_at);

-- The app role inserts views, so it needs the new sequence (default nextval).
GRANT USAGE, SELECT ON SEQUENCE usage_events_id_seq TO skilly_app;

COMMIT;
