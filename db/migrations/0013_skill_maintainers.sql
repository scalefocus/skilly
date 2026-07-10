-- Per-skill maintainers (SKILLY_SPEC.md §19): the EXPLICIT owner list. The effective set is
-- this list UNION the namespace admins of the skill's namespace (resolved live from
-- role_mappings at read time) — so admins are never copied here and can't drift.
-- Informational + notification target only; grants no authority (invariant #1). Ordinary
-- mutable rows. Both FKs cascade so deprovision / skill deletion clean up automatically.
-- (Table-level grants for skilly_app are inherited from the default privileges in 0002.)
BEGIN;

CREATE TABLE skill_maintainers (
  skill_id   UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  added_by   UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, user_id)
);
-- Reverse lookup: "skills I maintain" + notification fan-out by user.
CREATE INDEX idx_skill_maintainers_user ON skill_maintainers(user_id);

COMMIT;
