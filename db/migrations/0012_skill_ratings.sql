-- Skill ratings (SKILLY_SPEC.md §18): a 1-5 star, scalar-only quality signal.
-- One live rating per (user, skill); editable + revocable; ordinary MUTABLE rows
-- (never audit). Aggregates are denormalized onto `skills` via a rollup trigger so
-- catalog search stays a clean scalar read with no join fan-out.
-- (Table-level grants for skilly_app are inherited from the default privileges in 0002.)
BEGIN;

-- Denormalized aggregate carried on the skill row (like install_count).
ALTER TABLE skills ADD COLUMN rating_sum   BIGINT  NOT NULL DEFAULT 0;  -- sum of star values
ALTER TABLE skills ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0;  -- number of live ratings

CREATE TABLE skill_ratings (
  user_id      UUID     NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  skill_id     UUID     NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  stars        SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  rated_semver TEXT,                                   -- version the rater was on (provenance)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, skill_id)
);
-- Powers the per-skill distribution histogram on the detail page.
CREATE INDEX idx_skill_ratings_skill ON skill_ratings(skill_id);

-- Maintain skills.rating_sum / rating_count with deltas. AFTER ROW so the rating row
-- change is settled first. An upsert that conflicts fires AFTER UPDATE (not AFTER INSERT),
-- so each path applies exactly one correct delta. skill_id is immutable for a rating.
CREATE OR REPLACE FUNCTION skill_rating_rollup() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE skills SET rating_sum = rating_sum + NEW.stars,
                      rating_count = rating_count + 1
     WHERE id = NEW.skill_id;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE skills SET rating_sum = rating_sum + (NEW.stars - OLD.stars)
     WHERE id = NEW.skill_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE skills SET rating_sum = rating_sum - OLD.stars,
                      rating_count = rating_count - 1
     WHERE id = OLD.skill_id;
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_skill_rating_rollup
  AFTER INSERT OR UPDATE OR DELETE ON skill_ratings
  FOR EACH ROW EXECUTE FUNCTION skill_rating_rollup();

COMMIT;
