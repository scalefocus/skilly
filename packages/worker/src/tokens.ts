// Token reaper — deletes expired NON-install tokens. Runs on the leader.
// `install` tokens are EXEMPT: an expired install is an *inactive* installation that the user can
// reactivate or uninstall, so it must survive in the table (SKILLY_SPEC.md §23). With one_time/pat
// retired this is effectively a safety net for any residual legacy rows.
import type { Pool } from "pg";

export async function sweepExpiredTokens(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from tokens where type <> 'install' and expires_at is not null and expires_at <= now()`,
  );
  return rowCount ?? 0;
}
