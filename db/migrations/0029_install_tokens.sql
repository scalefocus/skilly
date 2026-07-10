-- 0029: install tokens — the durable consumer "installation" handle (SKILLY_SPEC.md §23).
-- Replaces the one_time/tokenless-org scheme with a reusable, skill-scoped, user-TTL'd,
-- owner-revocable token. PATs are removed.

-- New enum value. ADD VALUE is safe outside a txn (psql autocommits each statement); we don't
-- use 'install' in this migration, so there's no same-transaction-use restriction.
ALTER TYPE token_type ADD VALUE IF NOT EXISTS 'install';

-- Drop legacy ephemeral tokens (no production PATs to preserve; one_time was single-use anyway).
DELETE FROM tokens WHERE type IN ('pat', 'one_time');

-- Installation columns. skill_id is a real cascading FK so a hard-deleted skill takes its
-- installs with it; pinned_semver null = "latest"; client_user_agent captured at first clone.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS skill_id          UUID REFERENCES skills(id) ON DELETE CASCADE;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS pinned_semver     TEXT;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS client_user_agent TEXT;

-- The Installed Skills page lists a user's installs; the gateway/purge resolve by skill.
CREATE INDEX IF NOT EXISTS idx_tokens_install_user  ON tokens (user_id)  WHERE type = 'install';
CREATE INDEX IF NOT EXISTS idx_tokens_install_skill ON tokens (skill_id) WHERE type = 'install';
