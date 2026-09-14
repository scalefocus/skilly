-- Remove free-form skill tags (SKILLY_SPEC.md §10 Taxonomy). Tags were never rendered in the
-- catalog or on skill pages and were never a filter; categories are the single taxonomy now.
-- Stored tags are DROPPED, not converted — no categories are auto-created from them.
BEGIN;

-- The FTS trigger (0001, rewritten in 0020) referenced NEW.tags at weight C. Rewrite it without
-- tags BEFORE dropping the column: title=A, description=B, usage=D (weight C is unused).
CREATE OR REPLACE FUNCTION skills_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', coalesce(NEW.title,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.description,'')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.usage_search,'')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER trg_skills_tsv ON skills;
CREATE TRIGGER trg_skills_tsv
  BEFORE INSERT OR UPDATE OF title, description, usage_search ON skills
  FOR EACH ROW EXECUTE FUNCTION skills_tsv_update();

ALTER TABLE skills DROP COLUMN tags;

-- Recompute every vector so no stale tag terms linger in search_tsv.
UPDATE skills SET title = title;

COMMIT;
