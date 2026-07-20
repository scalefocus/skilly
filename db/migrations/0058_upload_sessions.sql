-- 0058: chunked hosted-bundle upload staging sessions (SKILLY_SPEC.md §3, §6).
-- Pure staging bookkeeping: the part bytes live in object storage under
-- uploads/staging/<id>/<index>; this row records ownership + the declared totals so the
-- part/complete endpoints can enforce exact byte accounting. Rows (and their parts) are
-- deleted on complete/abort, and any session older than 2 hours is swept at the start of
-- every new chunked upload. Never referenced by catalog tables; staged parts are never
-- servable. App-role grants inherit from 0002 (default privileges).
CREATE TABLE IF NOT EXISTS upload_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_slug  TEXT NOT NULL,
  filename    TEXT NOT NULL,
  total_bytes BIGINT NOT NULL,
  chunk_bytes INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS upload_sessions_created_at_idx ON upload_sessions (created_at);
CREATE INDEX IF NOT EXISTS upload_sessions_user_idx ON upload_sessions (user_id);
