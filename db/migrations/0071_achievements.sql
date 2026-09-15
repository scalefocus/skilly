-- Achievements (SKILLY_SPEC.md §31): one-time, non-competitive badges + the shareable hall.
--
--   user_achievements          one row per (user, badge key); no subject identity (invariant #3
--                              by construction). Written inline by awardAchievement() in the same
--                              transaction as the triggering write; seeded ONCE below from history.
--   users.achievements_hidden  the "show my achievements to others" opt-out (§31.5).
--   users.time_zone            the browser-reported IANA zone behind Night Shift / Weekend Warrior
--                              (§31.3). NULL until the web UI reports one; never guessed.
--
-- The history backfill (§31.6) seeds every key the existing tables can prove, earned_at = the
-- original event's timestamp, for non-erased users, and creates NO notifications (the migration
-- writes rows; only the runtime helper notifies). Night Shift / Weekend Warrior are deliberately
-- NOT seeded here — no timezone is known yet; they are backfilled per user on first capture.
-- Idempotent: ON CONFLICT DO NOTHING throughout.
BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS achievements_hidden BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS time_zone TEXT;

CREATE TABLE IF NOT EXISTS user_achievements (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- ---------------------------------------------------------------------------------------------
-- Backfill. Each block: (user_id, key, earned_at) from the earliest qualifying event.
-- ---------------------------------------------------------------------------------------------

-- first_install: the adoption ledger (git clone / first download / first MCP read — one fact).
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT si.user_id, 'first_install', min(si.first_at)
  FROM skill_installs si JOIN users u ON u.id = si.user_id AND u.erased_at IS NULL
 GROUP BY si.user_id
ON CONFLICT DO NOTHING;

-- first_marketplace: a personal marketplace key that has actually been served (approximation:
-- the key's mint time — the first fetch instant itself is not recorded).
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT t.user_id, 'first_marketplace', min(t.created_at)
  FROM tokens t JOIN users u ON u.id = t.user_id AND u.erased_at IS NULL
 WHERE t.type = 'marketplace' AND t.last_served_commit IS NOT NULL
 GROUP BY t.user_id
ON CONFLICT DO NOTHING;

-- first_mcp: a grant that has been used at least once (approximation: the grant's creation time).
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT g.user_id, 'first_mcp', min(g.created_at)
  FROM oauth_grants g JOIN users u ON u.id = g.user_id AND u.erased_at IS NULL
 WHERE g.last_used_at IS NOT NULL
 GROUP BY g.user_id
ON CONFLICT DO NOTHING;

-- triple_threat: derived — all three channel badges held; earned when the last one landed.
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT ua.user_id, 'triple_threat', max(ua.earned_at)
  FROM user_achievements ua
 WHERE ua.key IN ('first_install', 'first_marketplace', 'first_mcp')
 GROUP BY ua.user_id
HAVING count(DISTINCT ua.key) = 3
ON CONFLICT DO NOTHING;

-- first_request
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT r.requester_user_id, 'first_request', min(r.created_at)
  FROM skill_requests r JOIN users u ON u.id = r.requester_user_id AND u.erased_at IS NULL
 GROUP BY r.requester_user_id
ON CONFLICT DO NOTHING;

-- request_fulfilled (to the requester) / first_fulfilment (to the fulfiller): two distinct people.
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT r.requester_user_id, 'request_fulfilled', min(r.fulfilled_at)
  FROM skill_requests r JOIN users u ON u.id = r.requester_user_id AND u.erased_at IS NULL
 WHERE r.state = 'fulfilled' AND r.fulfilled_at IS NOT NULL
   AND r.fulfilled_by_user_id IS NOT NULL AND r.fulfilled_by_user_id <> r.requester_user_id
 GROUP BY r.requester_user_id
ON CONFLICT DO NOTHING;

INSERT INTO user_achievements (user_id, key, earned_at)
SELECT r.fulfilled_by_user_id, 'first_fulfilment', min(r.fulfilled_at)
  FROM skill_requests r JOIN users u ON u.id = r.fulfilled_by_user_id AND u.erased_at IS NULL
 WHERE r.state = 'fulfilled' AND r.fulfilled_at IS NOT NULL
   AND r.fulfilled_by_user_id <> r.requester_user_id
 GROUP BY r.fulfilled_by_user_id
ON CONFLICT DO NOTHING;

-- first_hosted_proposal / first_pointer_proposal: by the initial revision's artifact shape.
-- Pointer = a `pointer` source or a pointer Keep-current-files reuse (`reuse.external`); else hosted.
WITH initial AS (
  SELECT p.submitted_by AS user_id, p.created_at,
         (r.payload ? 'pointer' OR (r.payload #> '{reuse,external}') IS NOT NULL) AS is_pointer
    FROM proposals p
    JOIN proposal_revisions r ON r.proposal_id = p.id AND r.revision_no = 1
    JOIN users u ON u.id = p.submitted_by AND u.erased_at IS NULL
)
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT user_id, CASE WHEN is_pointer THEN 'first_pointer_proposal' ELSE 'first_hosted_proposal' END, min(created_at)
  FROM initial
 GROUP BY user_id, is_pointer
ON CONFLICT DO NOTHING;

-- first_published: a version the user submitted went live.
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT v.created_by, 'first_published', min(v.created_at)
  FROM skill_versions v JOIN users u ON u.id = v.created_by AND u.erased_at IS NULL
 GROUP BY v.created_by
ON CONFLICT DO NOTHING;

-- first_new_version: a version that is not the earliest version of its skill.
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT v.created_by, 'first_new_version', min(v.created_at)
  FROM skill_versions v JOIN users u ON u.id = v.created_by AND u.erased_at IS NULL
 WHERE EXISTS (SELECT 1 FROM skill_versions v0
                WHERE v0.skill_id = v.skill_id AND (v0.created_at, v0.id) < (v.created_at, v.id))
 GROUP BY v.created_by
ON CONFLICT DO NOTHING;

-- maintainer_added: explicit maintainer of a skill whose original proposer (the creator of the
-- skill's earliest version) is someone else.
WITH origin AS (
  SELECT DISTINCT ON (skill_id) skill_id, created_by
    FROM skill_versions ORDER BY skill_id, created_at, id
)
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT sm.user_id, 'maintainer_added', min(sm.created_at)
  FROM skill_maintainers sm
  JOIN users u ON u.id = sm.user_id AND u.erased_at IS NULL
  LEFT JOIN origin o ON o.skill_id = sm.skill_id
 WHERE o.created_by IS DISTINCT FROM sm.user_id
 GROUP BY sm.user_id
ON CONFLICT DO NOTHING;

-- first_message: any context.
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT m.author_id, 'first_message', min(m.created_at)
  FROM messages m JOIN users u ON u.id = m.author_id AND u.erased_at IS NULL
 GROUP BY m.author_id
ON CONFLICT DO NOTHING;

-- first_reply: a message in a conversation whose earliest message has a different author.
WITH opener AS (
  SELECT DISTINCT ON (conversation_id) conversation_id, author_id
    FROM messages ORDER BY conversation_id, created_at, id
)
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT m.author_id, 'first_reply', min(m.created_at)
  FROM messages m
  JOIN opener o ON o.conversation_id = m.conversation_id AND o.author_id <> m.author_id
  JOIN users u ON u.id = m.author_id AND u.erased_at IS NULL
 GROUP BY m.author_id
ON CONFLICT DO NOTHING;

-- first_mention
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT m.author_id, 'first_mention', min(m.created_at)
  FROM messages m
  JOIN users u ON u.id = m.author_id AND u.erased_at IS NULL
 WHERE EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id)
 GROUP BY m.author_id
ON CONFLICT DO NOTHING;

-- first_watch / first_rating
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT w.user_id, 'first_watch', min(w.created_at)
  FROM skill_watches w JOIN users u ON u.id = w.user_id AND u.erased_at IS NULL
 GROUP BY w.user_id
ON CONFLICT DO NOTHING;

INSERT INTO user_achievements (user_id, key, earned_at)
SELECT r.user_id, 'first_rating', min(r.created_at)
  FROM skill_ratings r JOIN users u ON u.id = r.user_id AND u.erased_at IS NULL
 GROUP BY r.user_id
ON CONFLICT DO NOTHING;

-- onboarded
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT u.id, 'onboarded', u.onboarded_at
  FROM users u
 WHERE u.onboarded_at IS NOT NULL AND u.erased_at IS NULL
ON CONFLICT DO NOTHING;

COMMIT;
