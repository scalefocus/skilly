-- 0098: Hype — a weekly boost for new and small skills (SKILLY_SPEC.md §50).
--
--   skill_hypes              one row per hype a user places on a skill. `points` is the §50.4
--                            early-hype bonus, frozen at insert (3 / 2 / 1 by how many in-window
--                            hypes the skill already had). No unique key: "one hype per skill per
--                            trailing 7 days" and the rolling budget are window rules enforced in
--                            the route under a per-user advisory lock (§50.2). Rows older than 7
--                            days are inert history — never shown, never counted, not deleted.
--                            Personal, mutable data: never audited, deleted on GDPR erasure (§4).
--   skill_hype_top           the worker sweep's memory of which skills are currently in the top N
--                            (`left_at IS NULL`), so it can tell an ENTRY from a skill that stays;
--                            `notified_at` is the once-per-7-days dedup for `skill.hyped` (§50.5).
--                            Written only by the worker.
--   users.hype_notifications the seventh maintainer notification preference (§12 / §50.7).
--
-- The five hype_* platform settings need no seed row (absent ⇒ default, §50.8). No backfill.
-- Table grants come from the 0002 default privileges; the bigserial's sequence is granted here.
BEGIN;

CREATE TABLE IF NOT EXISTS skill_hypes (
  id         BIGSERIAL PRIMARY KEY,
  skill_id   UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  points     SMALLINT NOT NULL CONSTRAINT skill_hypes_points_check CHECK (points BETWEEN 1 AND 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Score, hype count, hyper list and the tier count (per skill, newest first).
CREATE INDEX IF NOT EXISTS idx_skill_hypes_skill_created ON skill_hypes (skill_id, created_at DESC);
-- Budget and the already-hyped check (per user, newest first).
CREATE INDEX IF NOT EXISTS idx_skill_hypes_user_created ON skill_hypes (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS skill_hype_top (
  skill_id    UUID PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
  entered_at  TIMESTAMPTZ NOT NULL,
  left_at     TIMESTAMPTZ,
  notified_at TIMESTAMPTZ
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS hype_notifications BOOLEAN NOT NULL DEFAULT true;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skilly_app') THEN
    GRANT USAGE, SELECT ON SEQUENCE skill_hypes_id_seq TO skilly_app;
  END IF;
END
$$;

COMMIT;
