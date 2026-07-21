-- 0059: skill discussion (§24 "Skill discussion", §12). A third messaging context
-- (conversations.subject_type = 'skill', subject_id = skills.id) — the collapsible Discussion
-- card on the skill detail page. Two additive columns; no new tables. App-role grants inherit
-- from 0002 default privileges.
--
--  - messages.context_semver: the skill version a comment is about, stamped at post time from
--    the composer's version picker (skill-discussion messages only; NULL for every other
--    context and for a skill with no active version). Immutable with the message. §24.
--  - users.discussion_notifications: per-user opt-out for the coalesced skill.discussion
--    notification (default ON, existing users backfilled ON). Row-level, filtered at insert
--    time in the worker — like the 0057 maintainer opt-outs — but unlike new_version this also
--    silences watcher-derived recipients (its off-switch is not "unwatch"). §12/§24.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS context_semver TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discussion_notifications BOOLEAN NOT NULL DEFAULT true;

-- Coalesce skill.discussion the same way message.new is coalesced (migration 0053): one unread
-- row per recipient per conversation, refreshed in place (the upsert's ON CONFLICT targets this
-- partial index and preserves delivery bookkeeping). Keyed on conversationId only, so it is
-- context-agnostic like its message.new sibling. §12/§24.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_skilldisc_unread
  ON notifications (user_id, (payload->>'conversationId'))
  WHERE type = 'skill.discussion' AND read_at IS NULL;
