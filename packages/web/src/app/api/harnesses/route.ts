// Tool/harness vocabulary — the CLOSED coding-agent list (§3, §8). The propose form imports the
// list directly from @skilly/shared/agents; this endpoint mirrors it for any external consumer.
import { TOOL_OPTIONS } from "@skilly/shared";
import { currentAccess } from "../../../lib/guard";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  return Response.json({ agents: TOOL_OPTIONS, harnesses: TOOL_OPTIONS.map((a) => a.slug) });
}
