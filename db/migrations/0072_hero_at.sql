-- Achievement levels (SKILLY_SPEC.md §31.10): the permanent "Hero" high-water stamp.
--
--   users.hero_at   the moment the user FIRST held every badge in the catalog. NULL until then.
--
-- The level itself is never stored — it is count(*) over user_achievements, so it cannot drift
-- from the badges behind it and needs no column. Only Hero needs durability: the catalog grows
-- over time, and a Hero whose bar later reads 20/25 must stay a Hero (§31.10 "never demote").
-- A live `count(*) = <catalog size>` comparison would silently demote everyone the day a 21st
-- badge ships; this stamp is what makes that impossible.
--
-- Backfill: stamp every non-erased user whose existing rows already cover the whole catalog, with
-- earned_at of their LAST badge (the instant they actually completed the set) rather than now().
-- 20 is the catalog size AT THIS MIGRATION and is deliberately frozen here: a migration is a
-- point-in-time statement about history, and later catalog additions must not retroactively
-- change who was a Hero back then. The runtime helper (awardAchievement) owns every stamp after
-- this, always against the live catalog.
--
-- Idempotent: the ADD COLUMN is IF NOT EXISTS and the UPDATE only touches hero_at IS NULL rows.
BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS hero_at TIMESTAMPTZ;

UPDATE users u
   SET hero_at = full_house.completed_at
  FROM (
        SELECT ua.user_id, max(ua.earned_at) AS completed_at
          FROM user_achievements ua
         GROUP BY ua.user_id
        HAVING count(*) >= 20
       ) AS full_house
 WHERE full_house.user_id = u.id
   AND u.erased_at IS NULL
   AND u.hero_at IS NULL;

COMMIT;
