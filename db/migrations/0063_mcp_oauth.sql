-- 0063: the integrated MCP server (SKILLY_SPEC.md §29).
--
-- Three things land here:
--   (a) skilly's OAuth 2.1 authorization-server state (oauth_clients / oauth_grants /
--       oauth_tokens). Deliberately SEPARATE from `tokens`, whose semantics are now install-only
--       (§23): different lifetime, different presentation (Authorization header, never a URL) and
--       a different revocation model. No enum is widened and no column is reused.
--   (b) the "via MCP" attribution marker on the four kinds of content an agent can create, so a
--       human reading a proposal / message / rating / request can see how it arrived (§29).
--   (c) record_mcp_read() — the adoption recorder for a first SKILL.md read, gated by the SAME
--       skill_installs ledger as clones and downloads so the three channels are three doors to one
--       adoption and standings can't be farmed by switching channels (§21).
--
-- (Table-level grants for skilly_app are inherited from the default privileges set in 0002.)
BEGIN;

-- ── (a) OAuth authorization server ────────────────────────────────────────────────────────────

-- Registered MCP clients. Written by OPEN Dynamic Client Registration (RFC 7591): a client_id
-- grants nothing on its own — the gate is the human Entra login + consent leg. Public clients only
-- (`token_endpoint_auth_method = 'none'`): MCP CLI/desktop clients cannot keep a secret, and PKCE
-- is the compensating control. `blocked_at` is a platform-admin block; `last_used_at` drives both
-- the admin list and the 7-day prune of registrations that never produced a grant.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                  TEXT NOT NULL UNIQUE,
  client_name                TEXT NOT NULL,
  client_uri                 TEXT,
  logo_uri                   TEXT,
  redirect_uris              TEXT[] NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none'
                               CHECK (token_endpoint_auth_method = 'none'),
  software_id                TEXT,
  software_version           TEXT,
  registered_ip              TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at               TIMESTAMPTZ,
  blocked_at                 TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_pruning ON oauth_clients (created_at) WHERE last_used_at IS NULL;

-- One row per user×client delegation. THIS row is the "connection" a user sees and revokes on the
-- /mcp page. Revoked rows are kept (audit/forensics) and excluded by the partial unique index, so
-- re-consenting after a revoke creates a fresh grant while one live grant per pair is guaranteed.
CREATE TABLE IF NOT EXISTS oauth_grants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id           UUID NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  scope               TEXT NOT NULL DEFAULT 'mcp',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at        TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  revoked_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_grants_live
  ON oauth_grants (user_id, client_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants (user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_client ON oauth_grants (client_id);

-- One table, three kinds. An authorization code is a 60-second single-use credential with the same
-- lifecycle needs as an access/refresh token, so it doesn't earn its own table. `rotated_from_id`
-- is the rotation lineage that makes refresh-token REUSE DETECTION possible: presenting an
-- already-rotated refresh token revokes the entire grant (§22). Only the sha256 hash is stored —
-- the raw value exists only in the response to the client.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id        UUID NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('code', 'access', 'refresh')),
  hashed_token    TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  rotated_from_id UUID REFERENCES oauth_tokens(id) ON DELETE SET NULL,
  -- `code` rows only: the PKCE challenge, the redirect it was issued for, and the RFC 8707 resource.
  code_challenge  TEXT,
  redirect_uri    TEXT,
  resource        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Lookup is always by (kind, hash) — a hash is unique per kind in practice, and the index is the
-- hot path for every authenticated MCP request.
CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_tokens_kind_hash ON oauth_tokens (kind, hashed_token);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens (grant_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_sweep ON oauth_tokens (expires_at);

-- ── (b) "via MCP" attribution (§29) ───────────────────────────────────────────────────────────
-- One nullable column per content kind: NULL = created in the browser by a person; a value = the
-- registered client name that acted on the user's behalf. The presence of the value IS the marker,
-- so there is no separate boolean to keep in sync. The acting user is unchanged — MCP creates no
-- synthetic identity; this records how the act arrived, not who is responsible.
ALTER TABLE proposals      ADD COLUMN IF NOT EXISTS via_mcp_client TEXT;
ALTER TABLE messages       ADD COLUMN IF NOT EXISTS via_mcp_client TEXT;
ALTER TABLE skill_ratings  ADD COLUMN IF NOT EXISTS via_mcp_client TEXT;
ALTER TABLE skill_requests ADD COLUMN IF NOT EXISTS via_mcp_client TEXT;

-- ── (c) Adoption recorder for a first SKILL.md read over MCP (§21/§29) ────────────────────────
-- A near-twin of record_skill_download (0043): gated by the shared skill_installs ledger, so a
-- user who cloned or downloaded this skill before is NOT counted again. On a fresh adoption it
-- writes the access_log row (source = 'mcp_resource'), bumps install_count + the monthly counter,
-- and credits the skill's explicit maintainers excluding the reader themselves. Repeat reads are
-- no-ops for counting; the CALLER still logs raw activity separately if it wants to.
-- Returns true only on the reader's first adoption of this skill.
CREATE OR REPLACE FUNCTION record_mcp_read(p_skill_id uuid, p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_access_id uuid;
BEGIN
  INSERT INTO skill_installs (skill_id, user_id) VALUES (p_skill_id, p_user_id)
  ON CONFLICT (skill_id, user_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN false;  -- already adopted (prior clone, download OR MCP read) — never double-count
  END IF;

  INSERT INTO access_log (actor_user_id, skill_id, skill_version_id, source)
  VALUES (p_user_id, p_skill_id, NULL, 'mcp_resource')
  RETURNING id INTO v_access_id;

  UPDATE skills SET install_count = install_count + 1 WHERE id = p_skill_id;

  INSERT INTO install_counters (month, total)
  VALUES (date_trunc('month', now())::date, 1)
  ON CONFLICT (month) DO UPDATE SET total = install_counters.total + 1;

  INSERT INTO install_credits (access_log_id, user_id)
  SELECT v_access_id, sm.user_id
    FROM skill_maintainers sm JOIN users u ON u.id = sm.user_id
   WHERE sm.skill_id = p_skill_id AND sm.user_id <> p_user_id
     AND u.status = 'active' AND u.erased_at IS NULL
  ON CONFLICT DO NOTHING;

  RETURN true;
END;
$$;

COMMIT;
