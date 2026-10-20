-- Five badges for recent features (SKILLY_SPEC.md §31.12): Hype Squad (`first_hype`), Word of Mouth
-- (`first_share`), Glow Up (`first_icon`), Robot Sidekick (`first_ai_draft`) and Fresh Coat
-- (`first_update`). The catalog grows from 26 to 31. No schema change — `user_achievements.key` is
-- validated in code against the catalog.
--
-- History backfill, under the §31.6 rules: non-erased users only, earned_at = the earliest provable
-- event, NO notifications (only the runtime helper notifies). Sources (§31.12.7):
--   * first_hype     — the user's first skill_hypes row (hype rows are never deleted, so exact).
--   * first_share    — the user's first `skill.share_link_created` audit row (complete; the
--                      skill_share_links rows themselves are swept after expiry).
--   * first_icon     — the user's first proposal whose INITIAL revision is not a global
--                      (re-)promotion and either (a) is for a new skill and carries an icon (image or
--                      emoji), or (b) is a new-version proposal whose image the submitter uploaded
--                      (skill_icons.created_by). Bundle-borne icons arrive as the same payload fields.
--                      Not provable, so not seeded: emoji-only new-version
--                      proposals (a kept emoji and a chosen one look alike), direct publishes (no
--                      proposal row). Those users earn it on their next qualifying submission.
--   * first_ai_draft — the EARLIER of the first ok `skill_draft` AI call (§43; ai_usage keeps 365 days)
--                      and the first `skill.ai_draft_generated` run that modified at least one file (§44).
--   * first_update   — NOT seeded: tokens.last_served_semver is overwritten on every clone, so no
--                      earlier move forward is provable.
--
-- Hero (§31.10): stamp hero_at for any user this leaves holding the whole catalog, with the
-- earned_at of their LAST badge (the migration-0072 rule). 31 is the catalog size AT THIS MIGRATION
-- and is deliberately frozen here; in practice it stamps nobody (first_update is never seeded).
--
-- Idempotent: ON CONFLICT DO NOTHING, and the UPDATE only touches hero_at IS NULL rows.
BEGIN;

WITH events AS (
  SELECT h.user_id, 'first_hype'::text AS key, h.created_at AS at
    FROM skill_hypes h
  UNION ALL
  SELECT a.actor_user_id, 'first_share', a.created_at
    FROM audit_log a
   WHERE a.action = 'skill.share_link_created' AND a.actor_user_id IS NOT NULL
  UNION ALL
  SELECT p.submitted_by, 'first_icon', p.created_at
    FROM proposals p
    JOIN proposal_revisions r ON r.proposal_id = p.id AND r.revision_no = 1
   WHERE (r.payload ->> 'promotedFromSkillVersionId') IS NULL
     AND (
           (p.target_skill_id IS NULL
            AND (coalesce(r.payload -> 'metadata' ->> 'iconSha256', '') <> ''
                 OR btrim(coalesce(r.payload -> 'metadata' ->> 'iconEmoji', '')) <> ''))
        OR (p.target_skill_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM skill_icons i
                         WHERE i.sha256 = r.payload -> 'metadata' ->> 'iconSha256'
                           AND i.created_by = p.submitted_by))
         )
  UNION ALL
  SELECT u.user_id, 'first_ai_draft', u.created_at
    FROM ai_usage u
   WHERE u.feature = 'skill_draft' AND u.ok AND u.user_id IS NOT NULL
  UNION ALL
  SELECT a.actor_user_id, 'first_ai_draft', a.created_at
    FROM audit_log a
   WHERE a.action = 'skill.ai_draft_generated' AND a.actor_user_id IS NOT NULL
     AND coalesce((a.after -> 'files' ->> 'modified')::int, 0) >= 1
)
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT e.user_id, e.key, min(e.at)
  FROM events e JOIN users u ON u.id = e.user_id AND u.erased_at IS NULL
 GROUP BY e.user_id, e.key
ON CONFLICT DO NOTHING;

UPDATE users u
   SET hero_at = full_house.completed_at
  FROM (
        SELECT ua.user_id, max(ua.earned_at) AS completed_at
          FROM user_achievements ua
         GROUP BY ua.user_id
        HAVING count(*) >= 31
       ) AS full_house
 WHERE full_house.user_id = u.id
   AND u.erased_at IS NULL
   AND u.hero_at IS NULL;

COMMIT;
