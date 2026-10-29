// Import a whole repository — the scan (SKILLY_SPEC.md §64.3): list a git repository's SKILL.md
// folders at a ref, with each one's name, description, last-changed date and whether it can be
// imported. Any authenticated user; rate-limited like the ref pre-check. Nothing is stored or audited.
import { currentAccess } from "../../../../../lib/guard";
import { pool } from "../../../../../lib/db";
import { enforceRateLimit } from "../../../../../lib/ratelimit";
import { withSystemLog } from "../../../../../lib/apiLog";
import { scanRepository } from "../../../../../lib/repoImport";

export const dynamic = "force-dynamic";

export const POST = withSystemLog("/api/propose/import/scan", async function POST(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("import-scan", access.userId, 30);
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as { url?: unknown; ref?: unknown; folder?: unknown } | null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const r = await scanRepository(pool, access, { url: str(body?.url), ref: str(body?.ref), folder: str(body?.folder) || null });
  return r.ok ? Response.json(r.result) : Response.json({ error: r.error }, { status: r.status });
});
