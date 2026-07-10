-- 0054: "Featured skills" — a platform-admin homepage spotlight (SKILLY_SPEC.md §7).
-- Skill-level, independent of Official. featured_at IS NOT NULL == Featured (and is the
-- most-recent-first ordering key); featured_by records which admin pinned it (provenance).
-- App-role grants inherit from 0002 (default privileges).
BEGIN;

ALTER TABLE skills ADD COLUMN IF NOT EXISTS featured_at TIMESTAMPTZ;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS featured_by UUID REFERENCES users(id);

-- The homepage feed filters + orders by featured_at (desc); a partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_skills_featured ON skills (featured_at DESC) WHERE featured_at IS NOT NULL;

COMMIT;
