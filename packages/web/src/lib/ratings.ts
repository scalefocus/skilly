// Skill ratings (SKILLY_SPEC.md §18): 1-5 stars, one per (user, skill), editable + revocable.
// Ordinary mutable rows — NEVER audit. The skills.rating_sum/rating_count aggregate is kept
// in sync by the DB trigger trg_skill_rating_rollup; we only read it here.
import { pool } from "./db";

export interface RatingSummary {
  avg: number; // raw average (sum/count), 0 when no ratings
  count: number;
  distribution: number[]; // length 5; distribution[i] = number of (i+1)-star ratings
  mine: number | null; // the caller's own stars, or null if they haven't rated
}

/** Aggregate + distribution for a skill, plus the caller's own rating. */
export async function getRating(skillId: string, userId: string | null): Promise<RatingSummary> {
  const [distRes, mineRes] = await Promise.all([
    pool.query<{ stars: number; n: string }>(
      `select stars, count(*)::text as n from skill_ratings where skill_id = $1 group by stars`,
      [skillId],
    ),
    userId
      ? pool.query<{ stars: number }>(`select stars from skill_ratings where skill_id = $1 and user_id = $2`, [skillId, userId])
      : Promise.resolve({ rows: [] as { stars: number }[] }),
  ]);

  const distribution = [0, 0, 0, 0, 0];
  let sum = 0;
  let count = 0;
  for (const r of distRes.rows) {
    const n = Number(r.n);
    if (r.stars >= 1 && r.stars <= 5) distribution[r.stars - 1] = n;
    sum += r.stars * n;
    count += n;
  }
  return {
    avg: count ? sum / count : 0,
    count,
    distribution,
    mine: mineRes.rows[0]?.stars ?? null,
  };
}

/** Upsert the caller's rating (1-5). Stamps the version they were on (provenance). */
export async function setRating(userId: string, skillId: string, stars: number, ratedSemver: string | null): Promise<void> {
  await pool.query(
    `insert into skill_ratings (user_id, skill_id, stars, rated_semver)
       values ($1, $2, $3, $4)
     on conflict (user_id, skill_id)
       do update set stars = excluded.stars, rated_semver = excluded.rated_semver, updated_at = now()`,
    [userId, skillId, stars, ratedSemver],
  );
}

/** Revoke the caller's rating. The rollup trigger decrements the aggregate. */
export async function clearRating(userId: string, skillId: string): Promise<void> {
  await pool.query(`delete from skill_ratings where user_id = $1 and skill_id = $2`, [userId, skillId]);
}
