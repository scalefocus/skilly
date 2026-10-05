-- Skill collections (SKILLY_SPEC.md §37).
--
--   skill_collections       a user-owned, named list of skills (an onboarding pack). Any signed-in
--                           user owns up to 50; names are unique per owner ignoring case. Owning one
--                           grants no authority (invariant #1). Deleted on GDPR erasure (§37.10).
--   skill_collection_items  one row per (collection, skill). Members are org-visible, active,
--                           installable skills only; a skill that stops qualifying is evicted by the
--                           shared statement in @skilly/shared/collections (§37.4). A permanently
--                           deleted skill cascades its items away.
--
-- No backfill: both tables start empty. Grants come from the 0002 default privileges (SELECT,
-- INSERT, UPDATE, DELETE): these are ordinary mutable user data, not audit rows.
BEGIN;

CREATE TABLE IF NOT EXISTS skill_collections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT skill_collections_name_len CHECK (char_length(name) BETWEEN 1 AND 60 AND name = btrim(name)),
  CONSTRAINT skill_collections_description_len CHECK (description IS NULL OR char_length(description) <= 500)
);

-- Unique per owner, ignoring case (§37.1). Also serves the owner's own list.
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_collections_owner_name ON skill_collections (owner_id, lower(name));

CREATE TABLE IF NOT EXISTS skill_collection_items (
  collection_id UUID NOT NULL REFERENCES skill_collections(id) ON DELETE CASCADE,
  skill_id      UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, skill_id)
);

-- Eviction and the popup's "already a member" ticks look items up by skill.
CREATE INDEX IF NOT EXISTS idx_skill_collection_items_skill ON skill_collection_items (skill_id);

COMMIT;
