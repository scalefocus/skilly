// Overview stats. totalInstalls sums install_counters (ONE pre-aggregated row per calendar
// month, maintained by the git gateway at install time — 0018; backfilled from history at launch)
// so the all-time total is a cheap SUM over a small, bounded (one row per month) table instead of
// scanning access_log — page reloads can't be used to hammer an aggregate query. This is every
// clone (raw activity), not deduped per user — matches "this month" being raw activity too, as
// opposed to the deduped skills.install_count / leaderboard credits (§21). Auth-required like the
// rest of the catalog surface; the value is an org-wide total that identifies no individual skill.
import { currentAccess } from "../../../lib/guard";
import { pool } from "../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const { rows } = await pool.query<{ total: string }>(
    `select coalesce(sum(total), 0)::text as total from install_counters`,
  );
  return Response.json({ totalInstalls: Number(rows[0]?.total ?? 0) });
}
