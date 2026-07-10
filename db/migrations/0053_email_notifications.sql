-- 0053: the §12 email channel — per-user opt-out + the Graph email service account.
-- SKILLY_SPEC.md §3, §12. App-role grants inherit from 0002 (default privileges).

-- Per-user email-channel opt-out: default ON for everyone, including existing users.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications BOOLEAN NOT NULL DEFAULT true;

-- The admin-connected Graph sender (at most one). Token columns hold AES-256-GCM ciphertext
-- keyed by the env EMAIL_TOKEN_ENC_KEY — plaintext tokens never touch the database, logs, or
-- audit payloads (§12/§22). connected_by_user_id is provenance-only and survives GDPR erasure
-- as the tombstone label (users rows are scrubbed, never deleted).
-- One unread coalesced message.new row per (user, conversation) — the §12/§24 contract
-- "at most one email per conversation until read" needs the coalescing upsert to be ATOMIC
-- (two concurrent posts must never both insert). Dedupe any historical duplicates first
-- (keep the newest per user+conversation), then pin the invariant with a partial unique index;
-- fanOut upserts against it with ON CONFLICT DO UPDATE.
DELETE FROM notifications n
 USING notifications k
 WHERE n.type = 'message.new' AND k.type = 'message.new'
   AND n.read_at IS NULL AND k.read_at IS NULL
   AND n.user_id = k.user_id
   AND n.payload->>'conversationId' = k.payload->>'conversationId'
   AND (n.created_at < k.created_at OR (n.created_at = k.created_at AND n.id < k.id));

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_msgnew_unread
  ON notifications (user_id, (payload->>'conversationId'))
  WHERE type = 'message.new' AND read_at IS NULL;

CREATE TABLE IF NOT EXISTS email_service_account (
  id                      BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), -- single-row guard
  account_upn             TEXT NOT NULL,
  account_display_name    TEXT NOT NULL DEFAULT '',
  account_oid             TEXT NOT NULL,
  refresh_token_enc       TEXT NOT NULL,
  access_token_enc        TEXT,
  access_token_expires_at TIMESTAMPTZ,
  connected_by_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  connected_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_refresh_at         TIMESTAMPTZ,
  last_refresh_error      TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
