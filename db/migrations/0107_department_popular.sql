-- 0107: Popular in your department (SKILLY_SPEC.md §66).
--
-- The home page's "Popular in <department>" row groups colleagues' first adoptions
-- (skill_installs, §21) by users.department, matched trimmed and case-insensitively. This partial
-- expression index lets the query start from one department's users; their adoptions are then
-- reached through the existing idx_skill_installs_user. Nothing new is stored: the row is a live
-- query with a short in-process cache, and its on/off switch is the platform_settings key
-- `department_popular_enabled` (absent ⇒ on), which needs no schema.
--
-- Idempotent (IF NOT EXISTS). The expression must stay identical to the one the query uses
-- (`lower(btrim(department))`) or the planner won't pick the index.
CREATE INDEX IF NOT EXISTS idx_users_department_key
  ON users (lower(btrim(department)))
  WHERE department IS NOT NULL;
