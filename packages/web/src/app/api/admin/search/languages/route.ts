// Administration → Search: the search-language choices (SKILLY_SPEC.md §34.9) — the connected
// PostgreSQL server's built-in text-search configurations, the one in force, and the skill count the
// switch-language confirm dialog quotes. Platform-admin only. The switch itself is
// PATCH /api/admin/settings { searchLanguage }.
import { currentAccess } from "../../../../../lib/guard";
import { pool } from "../../../../../lib/db";
import { listSearchLanguages, getActiveSearchLanguage } from "../../../../../lib/searchAdmin";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access?.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const [languages, current, { rows }] = await Promise.all([
    listSearchLanguages(),
    getActiveSearchLanguage(),
    pool.query<{ n: string }>(`select count(*)::text as n from skills`),
  ]);
  return Response.json({ current, languages, skillCount: Number(rows[0]?.n ?? 0) });
}
