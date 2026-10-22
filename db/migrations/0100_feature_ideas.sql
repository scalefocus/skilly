-- 0100: Feature ideas — vote on what's next, and suggest it (SKILLY_SPEC.md §60).
--
--   feature_ideas            a user's feature suggestion. `pending` until a platform admin
--                            publishes it (into the What's new "Coming soon" list) or rejects it;
--                            a published idea is later `closed` with an outcome. The proposer may
--                            edit or withdraw while it is pending; `withdrawn` rows stay (hidden)
--                            so they still count toward the 5-a-day cap (§60.4).
--                            `description` is the text shown now (the admin may edit it when
--                            publishing); `submitted_description` is the proposer's own latest text.
--   feature_idea_votes       one upvote per user per published idea (§60.6). Closing an idea deletes
--                            its votes.
--   upcoming_votes           one upvote per user per spec'd teaser, keyed by the teaser's `key` in
--                            app/whats-new/upcoming.ts. No FK — teasers live in code; votes on a key
--                            that left the list are inert (§60.12).
--   users.idea_attribution_hidden  hides the proposer's name on their published ideas (§60.9).
--   users.idea_notifications       a platform admin's opt-out of `idea.submitted` (§60.7).
--   idx_notifications_idea_submitted_unread  one unread coalesced `idea.submitted` row per admin.
--
-- `feature_ideas_enabled` needs no seed row (absent ⇒ on, §60.9). No backfill: there is no history.
-- Ideas and votes are ordinary mutable rows, never audit data (§11). Table grants come from the 0002
-- default privileges.
BEGIN;

CREATE TABLE IF NOT EXISTS feature_ideas (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CONSTRAINT feature_ideas_status_check CHECK (status IN ('pending', 'published', 'rejected', 'closed', 'withdrawn')),
  description           TEXT NOT NULL CONSTRAINT feature_ideas_description_check CHECK (char_length(description) BETWEEN 20 AND 1000),
  submitted_description TEXT NOT NULL,
  title                 TEXT CONSTRAINT feature_ideas_title_check CHECK (title IS NULL OR char_length(title) BETWEEN 3 AND 80),
  outcome               TEXT CONSTRAINT feature_ideas_outcome_check CHECK (outcome IS NULL OR outcome IN ('planned', 'shipped', 'duplicate', 'wont_do')),
  admin_note            TEXT CONSTRAINT feature_ideas_note_check CHECK (admin_note IS NULL OR char_length(admin_note) <= 500),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at            TIMESTAMPTZ,
  published_at          TIMESTAMPTZ,
  closed_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  closed_at             TIMESTAMPTZ,
  shipped_at            TIMESTAMPTZ,
  -- A title once it is public; an outcome exactly when closed.
  CONSTRAINT feature_ideas_title_required CHECK (status NOT IN ('published', 'closed') OR title IS NOT NULL),
  CONSTRAINT feature_ideas_outcome_closed CHECK ((status = 'closed') = (outcome IS NOT NULL))
);

-- The Coming soon list and the admin Published tab.
CREATE INDEX IF NOT EXISTS idx_feature_ideas_status_published ON feature_ideas (status, published_at DESC);
-- "Your ideas" and the two submission caps.
CREATE INDEX IF NOT EXISTS idx_feature_ideas_author_created ON feature_ideas (author_id, created_at DESC);
-- The admin Pending tab (oldest first) and the nav badge count.
CREATE INDEX IF NOT EXISTS idx_feature_ideas_pending ON feature_ideas (created_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS feature_idea_votes (
  idea_id    UUID NOT NULL REFERENCES feature_ideas(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (idea_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_feature_idea_votes_user ON feature_idea_votes (user_id);

CREATE TABLE IF NOT EXISTS upcoming_votes (
  upcoming_key TEXT NOT NULL CONSTRAINT upcoming_votes_key_check CHECK (upcoming_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(upcoming_key) <= 60),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upcoming_key, user_id)
);
CREATE INDEX IF NOT EXISTS idx_upcoming_votes_user ON upcoming_votes (user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS idea_attribution_hidden BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS idea_notifications BOOLEAN NOT NULL DEFAULT true;

-- One unread `idea.submitted` row per platform admin: new submissions bump its count in place
-- (the message.new pattern, migration 0053), so an admin gets at most one email until they read it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_idea_submitted_unread
  ON notifications (user_id) WHERE type = 'idea.submitted' AND read_at IS NULL;

COMMIT;
