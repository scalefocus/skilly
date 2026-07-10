-- Hardening (SKILLY_SPEC.md §11, §14):
--  1. access_log gains skill_id so fetch records are linkable to a skill even when the exact
--     version isn't known at /info/refs time ("who cloned skill X?"). Nullable, set-null on
--     skill delete (access_log is high-volume provenance, not a hard FK we must preserve).
--  2. pending_mirrors gains attempt tracking so a permanently-bad pointer is dead-lettered
--     instead of re-cloned every sweep forever.
-- (Table-level grants for skilly_app are inherited from the default privileges in 0002.)
BEGIN;

ALTER TABLE access_log ADD COLUMN skill_id UUID REFERENCES skills(id) ON DELETE SET NULL;
CREATE INDEX idx_access_log_skill ON access_log(skill_id);

ALTER TABLE pending_mirrors ADD COLUMN attempts   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_mirrors ADD COLUMN last_error TEXT;

COMMIT;
