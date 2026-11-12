// Overview stats (SKILLY_SPEC.md §10 — the home page's stat row, §15).
//
// totalInstalls sums install_counters (ONE pre-aggregated row per calendar month, maintained by the
// git gateway at install time — 0018; backfilled from history at launch) so the all-time total is a
// cheap SUM over a small, bounded (one row per month) table instead of scanning access_log — page
// reloads can't be used to hammer an aggregate query. This is every clone (raw activity), not
// deduped per user — matches "this month" being raw activity too, as opposed to the deduped
// skills.install_count / leaderboard credits (§21). It is an org-wide total that identifies no
// individual skill, so it is not visibility-scoped.
//
// skills = the CALLER's visible active skills, in total and by source type — the same cached,
// visibility-filtered facet computation as the catalog's Source chips (invariant #3), so the
// Overview and the catalog can never disagree. Never the length of a listing: GET /api/skills is
// capped. Auth-required like the rest of the catalog surface.
import { currentAccess } from "../../../lib/guard";
import { pool } from "../../../lib/db";
import { visibleSkillCounts } from "../../../lib/catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const [{ rows }, skills] = await Promise.all([
    pool.query<{ total: string }>(`select coalesce(sum(total), 0)::text as total from install_counters`),
    visibleSkillCounts(access),
  ]);
  return Response.json({ totalInstalls: Number(rows[0]?.total ?? 0), skills });
}
