-- 0112: moving a skill to another namespace through a new-version proposal (SKILLY_SPEC.md §70).
--
--  * proposal_state gains 'awaiting_destination' — a move proposal the owner accepted, waiting for
--    the destination's reviewers (§70.3).
--  * proposals gains the move columns: the destination (mirrors the current revision) and the
--    owner-stage approval (who, when, which revision).
--  * skill_path_aliases: the old `<ns>/<slug>` addresses of a moved skill (§70.6). Resolved after the
--    live skill on every `<ns>/<slug>` surface, and reserving the slug in that namespace.
--
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction that also uses the new value, so this
-- migration is intentionally NOT wrapped in BEGIN/COMMIT (psql autocommits each statement) — the
-- partial indexes below use the new value — same shape as 0007 / 0064.
ALTER TYPE proposal_state ADD VALUE IF NOT EXISTS 'awaiting_destination' BEFORE 'accepted';

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS destination_namespace_id UUID REFERENCES namespaces(id) ON DELETE SET NULL;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS owner_accepted_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS owner_accepted_at TIMESTAMPTZ;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS owner_accepted_revision INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposals_destination_not_owner') THEN
    ALTER TABLE proposals ADD CONSTRAINT proposals_destination_not_owner
      CHECK (destination_namespace_id IS NULL OR destination_namespace_id <> target_namespace_id);
  END IF;
END $$;

-- routed_reason gains 'namespace_move' (0081 → 0091 → 0097 → here): a direct publish that moves the
-- skill somewhere the publisher can't publish directly is routed to review (§70.5).
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_routed_reason_check;
ALTER TABLE proposals
  ADD CONSTRAINT proposals_routed_reason_check
  CHECK (routed_reason IS NULL OR routed_reason IN ('content_risk', 'policy', 'scan_pending', 'namespace_move'));

-- The destination's review queue reads awaiting_destination proposals by destination.
CREATE INDEX IF NOT EXISTS idx_proposals_destination_open
  ON proposals (destination_namespace_id) WHERE state = 'awaiting_destination';

-- 0106's open-state partial indexes now cover the destination stage too.
DROP INDEX IF EXISTS idx_proposals_assignee_open;
CREATE INDEX IF NOT EXISTS idx_proposals_assignee_open
  ON proposals (assignee_id) WHERE state IN ('proposed', 'under_review', 'changes_requested', 'awaiting_destination');
DROP INDEX IF EXISTS idx_proposals_turn_due_open;
CREATE INDEX IF NOT EXISTS idx_proposals_turn_due_open
  ON proposals (turn_due_at) WHERE state IN ('proposed', 'under_review', 'changes_requested', 'awaiting_destination');

-- §65 turn clock, move-aware (§70.3): `awaiting_destination` is a reviewer turn timed on the
-- DESTINATION's review target; entering or leaving it starts a fresh turn (a new set of reviewers),
-- and so does a re-route (target_namespace_id changes when the skill moved, §70.7).
CREATE OR REPLACE FUNCTION proposals_review_turn() RETURNS trigger AS $$
DECLARE
  new_turn TEXT := CASE WHEN NEW.state IN ('proposed', 'under_review', 'awaiting_destination') THEN 'reviewer'
                        WHEN NEW.state = 'changes_requested' THEN 'proposer' END;
  old_turn TEXT;
  target SMALLINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.turn_started_at := coalesce(NEW.turn_started_at, now());
  ELSE
    old_turn := CASE WHEN OLD.state IN ('proposed', 'under_review', 'awaiting_destination') THEN 'reviewer'
                     WHEN OLD.state = 'changes_requested' THEN 'proposer' END;
    IF new_turn IS NOT NULL AND (
         new_turn IS DISTINCT FROM old_turn
         OR (NEW.state = 'awaiting_destination') IS DISTINCT FROM (OLD.state = 'awaiting_destination')
         OR NEW.target_namespace_id IS DISTINCT FROM OLD.target_namespace_id) THEN
      NEW.turn_started_at := now();
      NEW.turn_reminded_at := NULL;
      NEW.turn_escalated_at := NULL;
    END IF;
  END IF;

  IF new_turn IS NULL THEN
    -- Decided: no turn, no instants. The stamps stay as history.
    NEW.turn_due_at := NULL;
    NEW.turn_escalate_at := NULL;
    RETURN NEW;
  END IF;

  SELECT review_target_days INTO target FROM namespaces
   WHERE id = CASE WHEN NEW.state = 'awaiting_destination' AND NEW.destination_namespace_id IS NOT NULL
                   THEN NEW.destination_namespace_id ELSE NEW.target_namespace_id END;
  IF target IS NULL THEN
    NEW.turn_due_at := NULL;
    NEW.turn_escalate_at := NULL;
  ELSE
    NEW.turn_due_at := skilly_add_business_days(NEW.turn_started_at, target);
    NEW.turn_escalate_at := CASE WHEN new_turn = 'reviewer'
                                 THEN skilly_add_business_days(NEW.turn_started_at, 2 * target) END;
  END IF;

  -- A stamp whose instant moved into the future is cleared so it fires at the new instant; one
  -- whose instant is still past (or gone with the target) is kept, so a turn never pings twice.
  IF NEW.turn_reminded_at IS NOT NULL AND NEW.turn_due_at IS NOT NULL AND NEW.turn_due_at > now() THEN
    NEW.turn_reminded_at := NULL;
  END IF;
  IF NEW.turn_escalated_at IS NOT NULL AND NEW.turn_escalate_at IS NOT NULL AND NEW.turn_escalate_at > now() THEN
    NEW.turn_escalated_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_proposals_review_turn ON proposals;
CREATE TRIGGER trg_proposals_review_turn
  BEFORE INSERT OR UPDATE OF state, target_namespace_id, destination_namespace_id, turn_started_at ON proposals
  FOR EACH ROW EXECUTE FUNCTION proposals_review_turn();

CREATE OR REPLACE FUNCTION namespaces_review_target_changed() RETURNS trigger AS $$
BEGIN
  -- Touching turn_started_at fires trg_proposals_review_turn, which re-dates the row.
  UPDATE proposals SET turn_started_at = turn_started_at
   WHERE (target_namespace_id = NEW.id AND state IN ('proposed', 'under_review', 'changes_requested'))
      OR (destination_namespace_id = NEW.id AND state = 'awaiting_destination');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- §70.6 old addresses. One alias per (namespace, slug); a skill may hold several (A → B → C).
CREATE TABLE IF NOT EXISTS skill_path_aliases (
  namespace_id UUID NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  skill_id     UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_skill_path_aliases_skill ON skill_path_aliases (skill_id);

-- The reservation, defence in depth (the app checks first, under the per-slug lock): no live skill
-- row may sit at an alias of a DIFFERENT skill, and no alias may sit at a live skill's address.
CREATE OR REPLACE FUNCTION skill_path_alias_reserve_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM skill_path_aliases a
              WHERE a.namespace_id = NEW.namespace_id AND a.slug = NEW.slug AND a.skill_id <> NEW.id) THEN
    RAISE EXCEPTION 'skills: % is reserved in this namespace by a skill that moved out of it', NEW.slug
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_skill_path_alias_reserve ON skills;
CREATE TRIGGER trg_skill_path_alias_reserve
  BEFORE INSERT OR UPDATE OF namespace_id, slug ON skills
  FOR EACH ROW EXECUTE FUNCTION skill_path_alias_reserve_guard();

CREATE OR REPLACE FUNCTION skill_path_alias_live_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM skills s WHERE s.namespace_id = NEW.namespace_id AND s.slug = NEW.slug) THEN
    RAISE EXCEPTION 'skill_path_aliases: a skill already lives at this address'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_skill_path_alias_live ON skill_path_aliases;
CREATE TRIGGER trg_skill_path_alias_live
  BEFORE INSERT OR UPDATE ON skill_path_aliases
  FOR EACH ROW EXECUTE FUNCTION skill_path_alias_live_guard();
