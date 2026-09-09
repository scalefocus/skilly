// What's new "seen" marker — the server side of the once-per-release toast (SKILLY_SPEC.md §23,
// "What's new — release notes + the new-version toast"). `users.whats_new_seen_version` only ever
// moves forward: a stamp at or below the stored value is a no-op that still reports the stored
// value, so the endpoint is idempotent and a stale tab can never regress a fresher tab's stamp.
import { compareSemver, isValidSemver } from "@skilly/shared/semver";
import { pool } from "./db";

export interface WhatsNewStamp {
  /** The marker before this call (null = never stamped). */
  previous: string | null;
  /** The marker after this call — `version` when it advanced, else what was already stored. */
  current: string | null;
}

/**
 * Advance the user's marker to `version` if it is null or strictly lower (semver). `version` MUST
 * already be validated by the caller (`validateSeenVersion`). The UPDATE is guarded on the value we
 * observed, so two concurrent stamps can't race past each other: the loser simply re-reads.
 */
export async function stampWhatsNewSeen(userId: string, version: string): Promise<WhatsNewStamp> {
  const read = async () =>
    (await pool.query<{ whats_new_seen_version: string | null }>(`select whats_new_seen_version from users where id = $1`, [userId]))
      .rows[0]?.whats_new_seen_version ?? null;

  const previous = await read();
  // A corrupt stored value (not semver) is treated as never stamped, mirroring whatsNewAction().
  const lower = previous == null || !isValidSemver(previous) || compareSemver(previous, version) < 0;
  if (!lower) return { previous, current: previous };

  const upd = await pool.query(
    `update users set whats_new_seen_version = $2, updated_at = now()
       where id = $1 and whats_new_seen_version is not distinct from $3`,
    [userId, version, previous],
  );
  if ((upd.rowCount ?? 0) === 1) return { previous, current: version };
  // Lost a race to a concurrent stamp — report whatever landed.
  return { previous, current: await read() };
}
