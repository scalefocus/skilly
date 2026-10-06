-- Encore badge (SKILLY_SPEC.md §31.11): `first_version_proposal`, the first time a user puts forward
-- a new version of an EXISTING skill — a new-version proposal (web or MCP) or a direct publish of a
-- new version in a no-review namespace. The catalog grows from 23 to 24.
--
-- History backfill, under the §31.6 rules: non-erased users only, earned_at = the original event's
-- timestamp, NO notifications (only the runtime helper notifies). earned_at is the EARLIER of:
--   * the user's first proposal targeting an existing skill (target_skill_id set), excluding global
--     (re-)promotions — their initial revision carries `promotedFromSkillVersionId` (§31.11: a
--     promotion copies a version, it proposes no new content);
--   * the user's first non-first version of a skill that NO accepted proposal produced — i.e. a
--     historical direct publish, which left no proposal row. (Matched on skill + semver rather than
--     proposals.materialized_version_id, so pointer versions mirrored after acceptance are excluded
--     too.)
-- Reviewer-deleted proposals and versions of deleted skills cannot be proven; those users earn the
-- badge on their next qualifying submission.
--
-- Hero (§31.10): stamp hero_at for any user this leaves holding the whole catalog, with the
-- earned_at of their LAST badge (the migration-0072 rule). 24 is the catalog size AT THIS MIGRATION
-- and is deliberately frozen here; the runtime helper owns every stamp after this.
--
-- Idempotent: ON CONFLICT DO NOTHING, and the UPDATE only touches hero_at IS NULL rows.
BEGIN;

WITH proposed AS (
  SELECT p.submitted_by AS user_id, p.created_at AS at
    FROM proposals p
    JOIN proposal_revisions r ON r.proposal_id = p.id AND r.revision_no = 1
   WHERE p.target_skill_id IS NOT NULL
     AND (r.payload ->> 'promotedFromSkillVersionId') IS NULL
),
direct AS (
  SELECT v.created_by AS user_id, v.created_at AS at
    FROM skill_versions v
   WHERE v.created_by IS NOT NULL
     AND EXISTS (SELECT 1 FROM skill_versions v0
                  WHERE v0.skill_id = v.skill_id AND (v0.created_at, v0.id) < (v.created_at, v.id))
     AND NOT EXISTS (SELECT 1 FROM proposals p
                      WHERE p.target_skill_id = v.skill_id AND p.proposed_semver = v.semver
                        AND p.state = 'accepted')
),
events AS (
  SELECT user_id, at FROM proposed
  UNION ALL
  SELECT user_id, at FROM direct
)
INSERT INTO user_achievements (user_id, key, earned_at)
SELECT e.user_id, 'first_version_proposal', min(e.at)
  FROM events e JOIN users u ON u.id = e.user_id AND u.erased_at IS NULL
 GROUP BY e.user_id
ON CONFLICT DO NOTHING;

UPDATE users u
   SET hero_at = full_house.completed_at
  FROM (
        SELECT ua.user_id, max(ua.earned_at) AS completed_at
          FROM user_achievements ua
         GROUP BY ua.user_id
        HAVING count(*) >= 24
       ) AS full_house
 WHERE full_house.user_id = u.id
   AND u.erased_at IS NULL
   AND u.hero_at IS NULL;

COMMIT;
