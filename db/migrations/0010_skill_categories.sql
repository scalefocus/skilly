-- Categories become multi-valued + tag-like: a skill can carry several categories, and new
-- ones are created on the fly from the propose form. We keep the existing `categories` table
-- (so facets/search keep working) and add a join table; `skills.category_id` is retained for
-- back-compat but no longer the source of truth. SKILLY_SPEC.md §10.
-- (Table-level grants for skilly_app are inherited from the default privileges set in 0002.)
BEGIN;

CREATE TABLE skill_categories (
  skill_id    UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (skill_id, category_id)
);
CREATE INDEX idx_skill_categories_category ON skill_categories(category_id);

-- Backfill the existing single category into the join (no-op for fresh installs).
INSERT INTO skill_categories (skill_id, category_id)
SELECT id, category_id FROM skills WHERE category_id IS NOT NULL
ON CONFLICT DO NOTHING;

COMMIT;
