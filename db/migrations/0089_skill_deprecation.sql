-- Skill deprecation with a successor (SKILLY_SPEC.md §45).
--
--   skills.deprecated_at        non-null ⇒ the skill is DEPRECATED: it keeps serving and installing,
--                               but every surface marks it, it sorts after live skills, and the
--                               served `main` carries a deprecation hint commit (§45.4).
--   skills.deprecated_by        provenance — the admin who deprecated it (not audit; audit_log has
--                               the `skill.deprecated` / `skill.undeprecated` rows).
--   skills.successor_skill_id   the "use X instead" skill, optional. ON DELETE SET NULL so a
--                               hard-deleted successor leaves the deprecation (and its note) intact.
--   skills.deprecation_note     the admin's plain-text reason/instructions (≤ 1,000 chars, app-capped).
--
-- The CHECKs pin the model: a skill is never its own successor, and a non-deprecated skill carries
-- neither a successor nor a note (un-deprecating clears all four columns). The partial index serves
-- the reverse "Replaces <ns>/<slug>" lookup on the successor's detail page.
--
-- No backfill: nothing was deprecated before this change. Nothing on skill_versions changes — the
-- git hint lives on the mutable `main` branch only; every version tag stays byte-identical (§45.1).
BEGIN;

ALTER TABLE skills ADD COLUMN IF NOT EXISTS deprecated_at TIMESTAMPTZ;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS deprecated_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS successor_skill_id UUID REFERENCES skills(id) ON DELETE SET NULL;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS deprecation_note TEXT;

ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_successor_not_self;
ALTER TABLE skills ADD CONSTRAINT skills_successor_not_self
  CHECK (successor_skill_id IS DISTINCT FROM id);

ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_deprecation_shape;
ALTER TABLE skills ADD CONSTRAINT skills_deprecation_shape
  CHECK (deprecated_at IS NOT NULL OR (successor_skill_id IS NULL AND deprecation_note IS NULL));

CREATE INDEX IF NOT EXISTS idx_skills_successor ON skills (successor_skill_id) WHERE successor_skill_id IS NOT NULL;

COMMIT;
