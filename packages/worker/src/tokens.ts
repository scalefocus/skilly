// Token reaper — deletes expired LEGACY tokens. Runs on the leader.
// `install` tokens are EXEMPT: an expired install is an *inactive* installation that the user can
// reactivate or uninstall, so it must survive in the table (SKILLY_SPEC.md §23). `marketplace`
// tokens (§30.4) are exempt for exactly the same reason — an expired marketplace is listed-but-
// refused on /marketplaces and reactivating it revives the SAME URL, which is impossible if the
// row is gone. With one_time/pat retired this is effectively a safety net for residual legacy rows.
import type { Pool } from "pg";

export async function sweepExpiredTokens(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from tokens
      where type not in ('install', 'marketplace')
        and expires_at is not null and expires_at <= now()`,
  );
  return rowCount ?? 0;
}

/**
 * Sweep expired skill share links (§33.6) — a fourth, separate token regime (never a row in
 * `tokens`). No reactivation concept here (unlike install/marketplace tokens): an expired share
 * link is simply gone, and the Share button mints a fresh one next time. Same reaper cadence.
 */
export async function sweepExpiredShareLinks(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(`delete from skill_share_links where expires_at <= now()`);
  return rowCount ?? 0;
}
