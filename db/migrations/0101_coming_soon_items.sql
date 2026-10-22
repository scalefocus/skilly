-- 0101: Coming soon moves to the database (SKILLY_SPEC.md §60.2).
--
-- The What's new "Coming soon" list used to merge teasers written in code (app/whats-new/upcoming.ts,
-- one per spec-ahead GAP marker) with published feature ideas. From here on every item is a
-- `feature_ideas` row that platform admins publish, edit and close. This migration:
--   1. inserts the nine teasers upcoming.ts held as `published` rows with no proposer (author_id and
--      decided_by NULL), title = the teaser's title, description = submitted_description = its text,
--      created_at = decided_at = published_at stamped one second apart in the old display order with
--      the first item newest, so equal vote counts keep today's order (§60.1 decision 2);
--   2. copies every `upcoming_votes` row for those nine keys into `feature_idea_votes`, keeping
--      created_at, so no vote is lost;
--   3. drops `upcoming_votes` (migration 0100). Votes on any other key were never counted and go with it.
-- The texts are copied unchanged. Two of the nine were shown only to admins; there is no audience any
-- more, so they are now shown to everyone (§60.1 decision 16).
--
-- Idempotent: the rows carry fixed ids (ON CONFLICT DO NOTHING), and steps 2–3 run only while
-- `upcoming_votes` exists. Not audited: a one-off schema migration with no actor (§60.10).
BEGIN;

CREATE TEMP TABLE coming_soon_seed (
  id           UUID PRIMARY KEY,
  upcoming_key TEXT NOT NULL,
  ord          INT  NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO coming_soon_seed (id, upcoming_key, ord, title, description) VALUES
  ('dce851e7-a1c6-434b-b539-34e99f989951', 'skill-evals', 0, 'Skill evals',
   'Skills can ship their own test cases. Each new version is checked against them, so reviewers see what passes and what got worse.'),
  ('106c3c92-220a-4945-a696-b9b2a56eb068', 'upstream-release-alerts', 1, 'Upstream release alerts',
   'If you maintain a skill that points at another repository, you''ll hear when a newer release is out and can propose the update in one click.'),
  ('b83fd07a-da36-4a00-8652-1474b9a37324', 'try-before-installing', 2, 'Try a skill before installing',
   'Chat with the AI assistant with a skill loaded, right from its page, to see how it behaves before you install it.'),
  ('a594fd78-3f6f-4cd6-aefe-3adfe2b683fe', 'review-assignments', 3, 'Review assignments and deadlines',
   'Assign proposals to a reviewer, set a review target for your namespace, and get reminders when proposals wait too long.'),
  ('4b122d21-18f2-4c41-a965-d31483c07cb9', 'search-gaps', 4, 'Search gaps',
   'See what people search for and don''t find, with no one''s identity attached, and turn it into a synonym or a skill request.'),
  ('5e3529a7-c04e-40df-9d0e-6e21a5b7bc2d', 'popular-in-department', 5, 'Popular in your department',
   'A home-page row of the skills colleagues in your department are adopting.'),
  ('9079a8e5-3c78-46e0-8dc4-c290f181fe24', 'customize-a-skill', 6, 'Customize a skill for your team',
   'Make your own copy of a skill for your team, keep a link to the original, and hear when the original changes.'),
  ('34de0381-d9de-4400-b41d-800cc34d7ad2', 'import-repository', 7, 'Import a whole repository',
   'Point at a repository full of skills, tick the ones you want, and propose them all in one go.'),
  ('c459775f-7224-4d4f-9d57-3c6a2ec8a10e', 'usage-insights', 8, 'Usage insights',
   'Opt-in reporting from the plugin marketplaces, so maintainers see how often a skill is actually used, not just installed.');

INSERT INTO feature_ideas (id, author_id, status, title, description, submitted_description,
                           created_at, updated_at, decided_by, decided_at, published_at)
SELECT s.id, NULL, 'published', s.title, s.description, s.description, t.at, t.at, NULL, t.at, t.at
  FROM coming_soon_seed s
 CROSS JOIN LATERAL (SELECT now() - s.ord * interval '1 second' AS at) t
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF to_regclass('upcoming_votes') IS NOT NULL THEN
    INSERT INTO feature_idea_votes (idea_id, user_id, created_at)
    SELECT s.id, v.user_id, v.created_at
      FROM upcoming_votes v
      JOIN coming_soon_seed s ON s.upcoming_key = v.upcoming_key
      JOIN feature_ideas i ON i.id = s.id AND i.status = 'published'
    ON CONFLICT DO NOTHING;
    DROP TABLE upcoming_votes;
  END IF;
END $$;

COMMIT;
