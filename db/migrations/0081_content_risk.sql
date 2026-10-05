-- Content-risk scanner (SKILLY_SPEC.md §37).
--
--   content_risk_acknowledgements   a person with override authority accepted a version's
--                                   gate-tripping content findings (§37.6). Keyed to the VERSION
--                                   (skill_id + semver), because a pointer version doesn't exist
--                                   yet when its proposal is accepted. `pairs` is the set of
--                                   (rule, path) pairs acknowledged; a later report whose
--                                   gate-tripping pairs are all covered stays acknowledged.
--                                   Append-only: UPDATE and DELETE are revoked from the app role
--                                   (FK cascades still run, as the table owner).
--   proposals.routed_reason         'content_risk' when a direct publish was routed to review (§37.4).
--   users.content_risk_notifications  the Profile opt-out for skill.content_risk (§37.9).
--
-- No backfill: the worker's re-scan sweep (§37.5) checks every published version after deploy.
BEGIN;

CREATE TABLE IF NOT EXISTS content_risk_acknowledgements (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id         UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  semver           TEXT NOT NULL,
  scan_report_id   UUID REFERENCES scan_reports(id) ON DELETE SET NULL,
  pairs            JSONB NOT NULL DEFAULT '[]',
  acknowledged_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note             TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  source           TEXT NOT NULL CHECK (source IN ('override', 'manual'))
);

CREATE INDEX IF NOT EXISTS idx_content_risk_ack_version ON content_risk_acknowledgements (skill_id, semver);

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS routed_reason TEXT;
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_routed_reason_check;
ALTER TABLE proposals
  ADD CONSTRAINT proposals_routed_reason_check CHECK (routed_reason IS NULL OR routed_reason IN ('content_risk'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS content_risk_notifications BOOLEAN NOT NULL DEFAULT true;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skilly_app') THEN
    REVOKE UPDATE, DELETE ON content_risk_acknowledgements FROM skilly_app;
  END IF;
END
$$;

COMMIT;
