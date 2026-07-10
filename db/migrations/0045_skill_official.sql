-- "Official" endorsement badge (SKILLY_SPEC.md §7): a platform-admin-controlled, skill-level flag
-- marking first-party / sanctioned skills so users can tell endorsed from experimental. Purely a
-- trust/display signal — it changes NO security gate (scanning, review, install all unchanged).
-- official_at IS NOT NULL == Official; official_by records which admin set it (provenance).
-- Nullable, no backfill — nothing is Official until an admin marks it.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS official_at TIMESTAMPTZ;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS official_by UUID REFERENCES users(id);

-- The "Official only" catalog facet filters on this; a partial index keeps that cheap.
CREATE INDEX IF NOT EXISTS idx_skills_official ON skills (official_at) WHERE official_at IS NOT NULL;
