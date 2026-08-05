-- 0062: message mentions (SKILLY_SPEC.md §24 "Mentions", §12 `message.mention`).
-- A message body may embed `<@uuid>` (user) / `<#uuid>` (skill) tokens; alongside the immutable
-- message, one row per DISTINCT mention records what was referenced. `target_id` is polymorphic
-- (users.id or skills.id — no FK, like conversations.subject_id), so a mention survives its
-- target: user mentions resolve LIVE (users are never hard-deleted; erasure tombstones them),
-- while skill mentions capture the ns/slug handle in `label` at post time — the plain-text
-- fallback rendered after the skill is hard-deleted. User mentions store NO label (nothing for
-- GDPR erasure to scrub). Rows cascade with the message (moderator delete) and with the
-- conversation (subject deletion). ≤10 distinct mentions per message, enforced in the app.
-- (Table-level grants for skilly_app are inherited from the default privileges set in 0002.)
CREATE TABLE IF NOT EXISTS message_mentions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('user', 'skill')),
  target_id  UUID NOT NULL,
  label      TEXT,  -- skill mentions only: the "ns/slug" handle at post time
  PRIMARY KEY (message_id, kind, target_id)  -- PK prefix also serves the per-message resolution lookup
);
