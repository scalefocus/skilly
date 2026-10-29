// Import a whole repository — the submit (SKILLY_SPEC.md §64.6): up to 50 skills from one repo at
// one ref, each an ordinary pointer proposal (or a direct publish) of its own, outcome per skill.
// One hit against the proposals rate limit for the whole import.
import { currentAccess } from "../../../../lib/guard";
import { pool } from "../../../../lib/db";
import { enforceRateLimit } from "../../../../lib/ratelimit";
import { withSystemLog } from "../../../../lib/apiLog";
import { submitImport, type ImportSubmitInput } from "../../../../lib/repoImport";

export const dynamic = "force-dynamic";

export const POST = withSystemLog("/api/propose/import", async function POST(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("proposals", access.userId, 30);
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as ImportSubmitInput | null;
  if (!body || typeof body !== "object") return Response.json({ error: "send the import as JSON" }, { status: 400 });
  const r = await submitImport(pool, { ...access, userId: access.userId }, body);
  return r.ok ? Response.json(r.result) : Response.json({ error: r.error }, { status: r.status });
});
