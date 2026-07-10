-- Make skill search cover USAGE too (SKILLY_SPEC.md §10). Usage lives per-version
-- (skill_versions.usage_examples); we denormalize the latest active version's usage into
-- skills.usage_search and fold it into the FTS vector (weight D, below title/description/tags).
-- A trigger on skill_versions keeps it current across every publish path (hosted, pointer,
-- accept, direct-publish, promotion, yank). Visibility filtering stays in the query layer.
BEGIN;

ALTER TABLE skills ADD COLUMN usage_search TEXT;

-- Recompute the FTS vector including usage (D). Title=A, description=B, tags=C, usage=D.
CREATE OR REPLACE FUNCTION skills_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', coalesce(NEW.title,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.description,'')), 'B') ||
    setweight(to_tsvector('english', array_to_string(NEW.tags, ' ')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.usage_search,'')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER trg_skills_tsv ON skills;
CREATE TRIGGER trg_skills_tsv
  BEFORE INSERT OR UPDATE OF title, description, tags, usage_search ON skills
  FOR EACH ROW EXECUTE FUNCTION skills_tsv_update();

-- Keep usage_search synced to the latest ACTIVE version's usage. Updating skills.usage_search
-- fires trg_skills_tsv above, so search_tsv refreshes automatically.
CREATE OR REPLACE FUNCTION skills_usage_search_sync() RETURNS trigger AS $$
BEGIN
  UPDATE skills SET usage_search = (
    SELECT v.usage_examples FROM skill_versions v
     WHERE v.skill_id = NEW.skill_id AND v.status = 'active' AND v.usage_examples IS NOT NULL
     ORDER BY v.created_at DESC LIMIT 1
  ) WHERE id = NEW.skill_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_skill_versions_usage_search
  AFTER INSERT OR UPDATE OF usage_examples, status ON skill_versions
  FOR EACH ROW EXECUTE FUNCTION skills_usage_search_sync();

-- Backfill existing skills (this UPDATE fires trg_skills_tsv → recomputes search_tsv).
UPDATE skills s SET usage_search = (
  SELECT v.usage_examples FROM skill_versions v
   WHERE v.skill_id = s.id AND v.status = 'active' AND v.usage_examples IS NOT NULL
   ORDER BY v.created_at DESC LIMIT 1
);

COMMIT;
