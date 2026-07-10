// Readiness probe — checks DB connectivity. SKILLY_SPEC.md §14.
import { pool } from "../../lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await pool.query("select 1");
    return Response.json({ status: "ready" });
  } catch {
    return Response.json({ status: "not-ready" }, { status: 503 });
  }
}
