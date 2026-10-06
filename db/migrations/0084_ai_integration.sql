-- AI integration (SKILLY_SPEC.md §40).
--
--   ai_integration   the platform's ONE external LLM provider connection (single row, id = 1):
--                    provider (Open WebUI | Anthropic API), base URL, model, the provider token
--                    AES-256-GCM-encrypted under the env AI_TOKEN_ENC_KEY (never plaintext, never
--                    logged, never in audit payloads), its last 4 characters for the admin card,
--                    and the health bookkeeping behind the status pill (§40.8). No row = not
--                    configured; "Remove integration" hard-deletes it.
--   ai_usage         one row per provider call — counts only, never the prompt, the response, the
--                    base URL or the token (§40.3). 365-day retention (worker prune); user_id is
--                    nulled on GDPR erasure (§4).
--
-- No backfill: both tables start empty. Table grants come from the 0002 default privileges; the
-- bigserial sequence needs its own grant (the 0075 rule).
BEGIN;

CREATE TABLE IF NOT EXISTS ai_integration (
  id                      SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled                 BOOLEAN NOT NULL DEFAULT false,
  provider                TEXT NOT NULL CHECK (provider IN ('openwebui', 'anthropic')),
  base_url                TEXT NOT NULL CHECK (char_length(base_url) BETWEEN 1 AND 500),
  model                   TEXT NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  token_enc               TEXT NOT NULL,
  token_last4             TEXT NOT NULL,
  last_test_at            TIMESTAMPTZ,
  last_test_ok            BOOLEAN,
  last_test_error         TEXT,
  last_test_latency_ms    INTEGER,
  last_call_at            TIMESTAMPTZ,
  last_call_ok            BOOLEAN,
  last_call_error         TEXT,
  -- §40.8 throttle: a runtime failure claims the right to write a system_event only when this
  -- is NULL or older than 15 minutes (one conditional UPDATE, so web + worker never double-log).
  last_failure_logged_at  TIMESTAMPTZ,
  updated_by_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id             BIGSERIAL PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  feature        TEXT NOT NULL,
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  latency_ms     INTEGER NOT NULL,
  ok             BOOLEAN NOT NULL,
  error_code     TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_feature ON ai_usage (feature, created_at DESC);

GRANT USAGE, SELECT ON SEQUENCE ai_usage_id_seq TO skilly_app;

COMMIT;
