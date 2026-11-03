-- 0106: Review assignments and targets (SKILLY_SPEC.md §65).
--
--   namespaces.review_target_days     the namespace's review target in business days (1–30);
--                                     NULL = no target, no due dates, no reminders.
--   proposals.assignee_id / assigned_by / assignment_changed_at
--                                     the single, advisory assignee (§65.2) and who last changed
--                                     it (NULL = the worker sweep). assignment_changed_at feeds the
--                                     review badge (§65.5).
--   proposals.turn_*                  the current turn's clock (§65.3): when the reviewer's or the
--                                     proposer's turn started, its due and escalation instants, and
--                                     when this turn's reminder and escalation were sent.
--
--   skilly_add_business_days()        Monday–Friday in UTC, the same algorithm as the client-safe
--                                     `addBusinessDays` in @skilly/shared/review-target (a DB test
--                                     pins the two together).
--   trg_proposals_review_turn         keeps the turn columns right on every write path (the web
--                                     tier and the worker's MCP tools alike): a move between turns
--                                     starts a new turn; every write recomputes the instants from
--                                     the namespace's target; a reminder/escalation stamp whose
--                                     instant moved into the future is cleared so it fires again.
--   trg_namespaces_review_target      re-dates every open proposal of a namespace whose target
--                                     changes, in the settings transaction.
--
-- Backfill: turn_started_at from the latest request_changes / resubmit audit entry, else
-- created_at. No namespace has a target yet, so every instant stays NULL and the first reminder
-- sweep after this migration sends nothing.
BEGIN;

ALTER TABLE namespaces ADD COLUMN IF NOT EXISTS review_target_days SMALLINT
  CONSTRAINT namespaces_review_target_days_check CHECK (review_target_days BETWEEN 1 AND 30);

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS assignee_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS assigned_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS assignment_changed_at TIMESTAMPTZ;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS turn_started_at TIMESTAMPTZ;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS turn_due_at TIMESTAMPTZ;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS turn_escalate_at TIMESTAMPTZ;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS turn_reminded_at TIMESTAMPTZ;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS turn_escalated_at TIMESTAMPTZ;

-- Backfill the current turn's start (§65.9).
UPDATE proposals p
   SET turn_started_at = coalesce(
         CASE
           WHEN p.state = 'changes_requested' THEN
             (SELECT max(a.created_at) FROM audit_log a
               WHERE a.target_type = 'proposal' AND a.target_id = p.id::text AND a.action = 'proposal.request_changes')
           WHEN p.state IN ('proposed', 'under_review') THEN
             (SELECT max(a.created_at) FROM audit_log a
               WHERE a.target_type = 'proposal' AND a.target_id = p.id::text AND a.action IN ('proposal.resubmit', 'proposal.resubmitd'))
         END,
         p.created_at)
 WHERE p.turn_started_at IS NULL;

ALTER TABLE proposals ALTER COLUMN turn_started_at SET DEFAULT now();
ALTER TABLE proposals ALTER COLUMN turn_started_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_proposals_assignee_open
  ON proposals (assignee_id) WHERE state IN ('proposed', 'under_review', 'changes_requested');
CREATE INDEX IF NOT EXISTS idx_proposals_turn_due_open
  ON proposals (turn_due_at) WHERE state IN ('proposed', 'under_review', 'changes_requested');

-- One unread folded reminder per recipient, type and namespace (§65.4).
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_review_reminders_unread
  ON notifications (user_id, type, (payload->>'nsId'))
  WHERE type IN ('proposal.review_overdue', 'proposal.review_escalated', 'proposal.changes_reminder') AND read_at IS NULL;

CREATE OR REPLACE FUNCTION skilly_add_business_days(p_start TIMESTAMPTZ, p_days INTEGER) RETURNS TIMESTAMPTZ AS $$
DECLARE
  t TIMESTAMP := p_start AT TIME ZONE 'UTC';
  i INTEGER;
BEGIN
  IF extract(isodow FROM t) = 6 THEN
    t := date_trunc('day', t) + interval '2 days';
  ELSIF extract(isodow FROM t) = 7 THEN
    t := date_trunc('day', t) + interval '1 day';
  END IF;
  t := t + make_interval(days => (p_days / 5) * 7);
  FOR i IN 1 .. (p_days % 5) LOOP
    t := t + interval '1 day';
    IF extract(isodow FROM t) = 6 THEN
      t := t + interval '2 days';
    END IF;
  END LOOP;
  RETURN t AT TIME ZONE 'UTC';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION proposals_review_turn() RETURNS trigger AS $$
DECLARE
  new_turn TEXT := CASE WHEN NEW.state IN ('proposed', 'under_review') THEN 'reviewer'
                        WHEN NEW.state = 'changes_requested' THEN 'proposer' END;
  old_turn TEXT;
  target SMALLINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.turn_started_at := coalesce(NEW.turn_started_at, now());
  ELSE
    old_turn := CASE WHEN OLD.state IN ('proposed', 'under_review') THEN 'reviewer'
                     WHEN OLD.state = 'changes_requested' THEN 'proposer' END;
    IF new_turn IS NOT NULL AND new_turn IS DISTINCT FROM old_turn THEN
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

  SELECT review_target_days INTO target FROM namespaces WHERE id = NEW.target_namespace_id;
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
  BEFORE INSERT OR UPDATE OF state, target_namespace_id, turn_started_at ON proposals
  FOR EACH ROW EXECUTE FUNCTION proposals_review_turn();

CREATE OR REPLACE FUNCTION namespaces_review_target_changed() RETURNS trigger AS $$
BEGIN
  -- Touching turn_started_at fires trg_proposals_review_turn, which re-dates the row.
  UPDATE proposals SET turn_started_at = turn_started_at
   WHERE target_namespace_id = NEW.id AND state IN ('proposed', 'under_review', 'changes_requested');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_namespaces_review_target ON namespaces;
CREATE TRIGGER trg_namespaces_review_target
  AFTER UPDATE OF review_target_days ON namespaces
  FOR EACH ROW WHEN (OLD.review_target_days IS DISTINCT FROM NEW.review_target_days)
  EXECUTE FUNCTION namespaces_review_target_changed();

COMMIT;
