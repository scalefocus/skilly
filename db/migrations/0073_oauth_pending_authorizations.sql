-- §29: the consent handoff between GET /oauth/authorize (render) and POST /oauth/consent (submit).
--
-- These are two separate server entry points with no guarantee of sharing a process: they do not
-- under `next dev`'s per-route bundling, and they do not across the 2-6 web replicas the HPA runs.
-- Holding the validated request in process memory therefore made consent fail closed with a 400
-- ("this consent request expired or was already used") whenever the submit landed elsewhere than
-- the render. It lives in the database instead.
--
-- Not a fourth `kind` on oauth_tokens: nothing here is a credential (the PKCE challenge is a public
-- value and no token exists yet), it never leaves the server, and it dies at consent time rather
-- than joining the rotation lineage that makes reuse detection possible.
--
-- (Table-level grants for skilly_app are inherited from the default privileges set in 0002.)
BEGIN;

CREATE TABLE IF NOT EXISTS oauth_pending_authorizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  client_id   uuid NOT NULL REFERENCES oauth_clients(id)  ON DELETE CASCADE,
  -- The ALREADY-VALIDATED authorize request: redirect_uri, code_challenge, code_challenge_method,
  -- state, resource, scope. The consent handler reads the request from here and trusts nothing
  -- from the form except the opaque id above and the approve/deny decision, so a redirect_uri or
  -- client_id edited between render and submit is never read at all.
  request     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);

-- The consume path: single-use, 10-minute TTL, bound to the user it was stashed for. Covers the
-- exact predicate of that UPDATE ... RETURNING.
CREATE INDEX IF NOT EXISTS idx_oauth_pending_auth_live
  ON oauth_pending_authorizations (id, user_id)
  WHERE consumed_at IS NULL;

-- The housekeeping sweep's predicate (drops consumed and expired rows alike).
CREATE INDEX IF NOT EXISTS idx_oauth_pending_auth_created
  ON oauth_pending_authorizations (created_at);

COMMIT;
