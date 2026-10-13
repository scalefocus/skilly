-- Replies to skill-discussion comments, one level (SKILLY_SPEC.md §24 "Replies to discussion
-- comments", §12 `skill.discussion_reply`).
--
--   messages.parent_id   a reply's top-level comment (NULL = a top-level comment). The server
--                        enforces, on insert, that the parent is in the same conversation, that the
--                        parent is itself top-level (one level — a reply to a reply is normalised to
--                        its root), and that only subject_type='skill' conversations take a parent.
--                        CASCADE: hard-deleting a top-level comment takes its replies with it (a
--                        root with live replies is tombstoned instead, so this fires only for an
--                        emptied tombstone or a skill/conversation purge).
--   messages.removed_at  a moderator tombstone: the body is cleared, its message_mentions rows are
--                        deleted and this is stamped — the ONLY in-place mutation of a message.
--   skill.discussion_reply coalescing: one unread row per (recipient, root comment), refreshed in
--                        place by an atomic upsert that preserves delivery bookkeeping — the
--                        skill.discussion pattern (0059), keyed on the thread's root instead.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages (parent_id) WHERE parent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_discreply_unread
  ON notifications (user_id, (payload->>'rootId'))
  WHERE type = 'skill.discussion_reply' AND read_at IS NULL;
