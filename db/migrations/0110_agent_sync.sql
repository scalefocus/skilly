-- 0110: Agent sync API (SKILLY_SPEC.md §69).
--
-- A desktop agent (first client: AION) exchanges an Entra access token for the list of skills its
-- user may see plus one short-lived AGENT KEY, and clones those skills from the git gateway.
--
--   token_type 'agent'   the agent key: a `tokens` row owned by a user, not scoped to a skill. The
--                        gateway serves any skill its owner can see at the moment of the request.
--                        Always expires (≤ 24 h), never a system token, hash only — no token_enc.
--                        The token reaper deletes expired rows (it exempts only install/marketplace).
--   agent_installs       one row per (user, skill, source) for a skill an agent cloned. Written by
--                        the gateway, pruned by each sync, listed on the owner's Installed page.
--                        DISPLAY ONLY: no install count, ledger, credit, achievement or notification
--                        reads it (§69.7).
--
-- access_log.source is free text; agent clones are recorded with 'aion' (no schema change).
-- audit_source already has 'api'. Table grants come from the 0002 default privileges.
--
-- NO BEGIN/COMMIT: psql autocommits each statement, so `ALTER TYPE ... ADD VALUE` commits before
-- the CHECK and the partial index below reference the new label. Same pattern as 0029 and 0065.

ALTER TYPE token_type ADD VALUE IF NOT EXISTS 'agent';

-- The discriminant gains the agent case. Replaced in ONE statement so there is never a moment
-- without the constraint; re-running it is a no-op in effect.
ALTER TABLE tokens
  DROP CONSTRAINT IF EXISTS tokens_scope_discriminant,
  ADD CONSTRAINT tokens_scope_discriminant CHECK (
    CASE type
      WHEN 'install' THEN
        skill_id IS NOT NULL AND marketplace_scope IS NULL AND namespace_id IS NULL
      WHEN 'marketplace' THEN
        skill_id IS NULL
        AND marketplace_scope IN ('public', 'namespace')
        AND (namespace_id IS NOT NULL) = (marketplace_scope = 'namespace')
        AND is_system = false
      WHEN 'agent' THEN
        skill_id IS NULL AND marketplace_scope IS NULL AND namespace_id IS NULL
        AND user_id IS NOT NULL
        AND is_system = false
        AND expires_at IS NOT NULL
      ELSE TRUE
    END
  );

-- The per-user cap (keep the 5 newest unexpired keys) reads a user's agent keys newest first.
CREATE INDEX IF NOT EXISTS idx_tokens_agent_user ON tokens (user_id, created_at DESC) WHERE type = 'agent';

CREATE TABLE IF NOT EXISTS agent_installs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  skill_id           UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  source             TEXT NOT NULL CONSTRAINT agent_installs_source CHECK (source IN ('aion')),
  first_cloned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_cloned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A plain string like tokens.last_served_semver: a later version delete leaves the row readable.
  last_served_semver TEXT,
  client_user_agent  TEXT,
  client_ip          TEXT,
  CONSTRAINT agent_installs_one_per_user_skill_source UNIQUE (user_id, skill_id, source)
);
CREATE INDEX IF NOT EXISTS idx_agent_installs_skill ON agent_installs (skill_id);
