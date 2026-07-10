// "Skills you might like" recompute (worker, leader-only). Rebuilds the related_skills table
// (migration 0046) from the co-install ledger skill_installs (0043): for each skill, the other
// skills most-often adopted by the same users. Pure co-install signal — no content similarity.
// Runs nightly AND on-demand (an admin can request a rebuild from the Administration page — the
// web tier sets platform_settings.related_rebuild_requested_at, the worker's signal poll picks it
// up). SKILLY_SPEC.md §10.
import type { Pool } from "pg";

// Stable advisory-lock key so the nightly sweep and an on-demand admin rebuild never run the
// DELETE+INSERT concurrently (they'd contend / double-work). Distinct from the leader lock (855399).
const RELATED_LOCK_KEY = 855400;

/**
 * Rebuild related_skills wholesale from the co-install graph. For each active skill we keep the
 * top `topN` other active skills by number of shared adopters (a wide candidate list, so the read
 * path can drop any the viewer can't see and still fill the top 3 visible). Runs in one transaction
 * (DELETE + INSERT) under a try-advisory-lock so concurrent invocations (nightly vs on-demand) don't
 * collide — a second caller returns **-1** ("skipped, a rebuild is already running") rather than
 * blocking. On success also stamps the last-run status (time + count) into platform_settings for the
 * admin Maintenance card. Returns the number of edge rows written, or -1 if skipped.
 */
export async function recomputeRelatedSkills(pool: Pool, topN = 12): Promise<number> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [RELATED_LOCK_KEY]);
    if (!lock.rows[0]?.ok) return -1; // another rebuild is in progress — skip (equivalent work)
    try {
      await client.query("begin");
      await client.query("delete from related_skills");
      // Self-join skill_installs on user_id: each shared adopter contributes one row per ordered
      // (a,b) skill pair (PK(skill_id,user_id) means one row per user-skill), so count(*) = shared
      // adopters. Both sides constrained to active skills. row_number keeps the top-N per skill.
      const res = await client.query(
        `insert into related_skills (skill_id, related_skill_id, shared_count)
         select skill_id, related_skill_id, shared_count from (
           select a.skill_id,
                  b.skill_id as related_skill_id,
                  count(*)   as shared_count,
                  row_number() over (partition by a.skill_id order by count(*) desc, b.skill_id) as rn
             from skill_installs a
             join skill_installs b on b.user_id = a.user_id and b.skill_id <> a.skill_id
             join skills sa on sa.id = a.skill_id and sa.status = 'active'
             join skills sb on sb.id = b.skill_id and sb.status = 'active'
            group by a.skill_id, b.skill_id
         ) ranked
         where rn <= $1`,
        [topN],
      );
      const count = res.rowCount ?? 0;
      // Persist last-run status (read by the admin Maintenance card). updated_by is left null =
      // "system" (platform_settings.updated_by is nullable), since no user runs the sweep itself.
      await client.query(
        `insert into platform_settings (key, value, updated_at) values
           ('related_last_run_at', to_jsonb(now()::text), now()),
           ('related_last_run_count', to_jsonb($1::int), now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [count],
      );
      await client.query("commit");
      return count;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      await client.query("select pg_advisory_unlock($1)", [RELATED_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
