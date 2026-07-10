-- Pointer skills may live in a SUBDIRECTORY of a multi-skill upstream repo (e.g. the
-- `frontend-design/` folder of anthropics/skills). The proposer optionally supplies that
-- folder; the worker mirrors ONLY that subdir (rebased so SKILL.md lands at the mirror root),
-- keeping skilly's "one skill = one repo, SKILL.md at root" model intact. NULL = repo root.
-- Captured per-version (immutable with the pinned ref) so upstream restructuring across
-- releases is tolerated. SKILLY_SPEC.md §6, §3.
BEGIN;

ALTER TABLE skill_versions  ADD COLUMN external_subdir TEXT;
ALTER TABLE pending_mirrors ADD COLUMN external_subdir TEXT;

COMMIT;
