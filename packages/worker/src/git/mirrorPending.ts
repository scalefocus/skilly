// Drains pending_mirrors (enqueued when a pointer proposal is accepted / direct-published):
// clones the pinned ref, validates + scans, stores the artifact, inserts the immutable
// version. The publish sweep then synthesizes the git tag. SKILLY_SPEC.md §6, §8.
import type { Pool } from "pg";
import type { ArtifactStore } from "../storage/objectStore.js";
import { mirrorPointerVersion } from "./mirror.js";
import { sweepBatchSize } from "./publish.js";

// A pointer that fails to mirror this many times is dead-lettered (deleted) instead of
// re-cloned forever — e.g. a bad URL/ref or a now-unsafe pointer rejected by validation.
const MAX_MIRROR_ATTEMPTS = Number(process.env.MIRROR_MAX_ATTEMPTS ?? 5);

interface PendingRow {
  id: string;
  skill_id: string;
  semver: string;
  external_url: string;
  external_ref: string;
  external_subdir: string | null;
  is_prerelease: boolean;
  created_by: string | null;
  skill_slug: string;
  attempts: number;
}

export async function mirrorPendingVersions(pool: Pool, deps: { store: ArtifactStore }): Promise<number> {
  const { rows } = await pool.query<PendingRow>(
    `select pm.id, pm.skill_id, pm.semver, pm.external_url, pm.external_ref, pm.external_subdir, pm.is_prerelease, pm.created_by, pm.attempts, s.slug as skill_slug
       from pending_mirrors pm join skills s on s.id = pm.skill_id
      where pm.attempts < $1
      order by pm.created_at asc
      limit ${sweepBatchSize()}`,
    [MAX_MIRROR_ATTEMPTS],
  );

  let mirrored = 0;
  for (const r of rows) {
    // Idempotency: if the version already exists (prior partial run), just clear the queue.
    const exists = await pool.query(`select 1 from skill_versions where skill_id = $1 and semver = $2`, [r.skill_id, r.semver]);
    if (exists.rowCount) {
      await pool.query(`delete from pending_mirrors where id = $1`, [r.id]);
      continue;
    }
    try {
      await mirrorPointerVersion(pool, deps.store, {
        skillId: r.skill_id,
        skillSlug: r.skill_slug,
        semver: r.semver,
        externalUrl: r.external_url,
        ref: r.external_ref,
        subdir: r.external_subdir,
        createdBy: r.created_by,
        isPrerelease: r.is_prerelease,
      });
      await pool.query(`delete from pending_mirrors where id = $1`, [r.id]);
      mirrored++;
    } catch (err) {
      // Record the attempt + error. Once attempts hit the cap the row stops being selected
      // (dead-lettered) instead of being re-cloned every sweep. Transient failures retry.
      const msg = String(err);
      await pool.query(`update pending_mirrors set attempts = attempts + 1, last_error = $2 where id = $1`, [r.id, msg]);
      const parked = r.attempts + 1 >= MAX_MIRROR_ATTEMPTS;
      console.error(JSON.stringify({ level: parked ? "warn" : "error", msg: parked ? "mirror dead-lettered (max attempts)" : "mirror failed", pendingId: r.id, ref: r.external_ref, attempts: r.attempts + 1, err: msg }));
    }
  }
  return mirrored;
}
