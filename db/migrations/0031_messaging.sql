-- Messaging — SKILLY_SPEC.md §24. A GENERAL conversation/message system; its first use is
-- review discussions between a proposal's submitter and its reviewers/maintainers, but the model
-- is deliberately context-polymorphic so it can later carry skill threads or direct DMs.
-- (Table-level grants for skilly_app are inherited from the default privileges set in 0002.)
BEGIN;

-- A thread. `subject_type`/`subject_id` is the polymorphic context: 'proposal' -> proposals.id
-- today; subject_id NULL is reserved for future contextless/direct conversations.
CREATE TABLE conversations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type TEXT NOT NULL,
  subject_id   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()  -- bumped on each new message (list ordering)
);
-- One conversation per concrete subject (proposal). Partial so multiple NULL-subject (direct)
-- conversations remain allowed.
CREATE UNIQUE INDEX uq_conversations_subject ON conversations (subject_type, subject_id)
  WHERE subject_id IS NOT NULL;

-- Who has ENGAGED with a thread + their personal read clock. A user can read a conversation
-- they're allowed to see (checked dynamically against the context) before a row exists here; the
-- row is created when they first open/post, and tracks "read up to".
CREATE TABLE conversation_participants (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

-- Immutable messages (no edit/delete in v1). `body` is plain UTF-8 text — native emoji included.
CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_id       UUID NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);

COMMIT;
