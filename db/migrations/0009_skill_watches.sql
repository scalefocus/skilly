-- Tier 4: watch / follow. Users can watch a skill and get notified when a new version is
-- published. Notifications are created by the worker's publish sweep (single point covering
-- both hosted and pointer). SKILLY_SPEC.md §12, §16 (deferred → now delivered).
-- (Table-level grants for skilly_app are inherited from the default privileges set in 0002.)
BEGIN;

CREATE TABLE skill_watches (
  user_id    UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  skill_id   UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, skill_id)
);
CREATE INDEX idx_skill_watches_skill ON skill_watches(skill_id);

COMMIT;
