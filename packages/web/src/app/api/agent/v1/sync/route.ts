// The agent sync API (SKILLY_SPEC.md §69). A machine endpoint: bearer Entra access token only
// (delegated scope `Skills.Sync`) — no session, no CSRF, cookies never read. Returns every skill the
// token's user may see plus one short-lived agent key for the git gateway.
//
// Off unless SKILLY_AGENT_API_ENABLED=true (404 otherwise). Deliberately NOT wrapped in
// withSystemLog: 401s, 403s and 429s here are machine traffic (§25); the handler records its own
// 500s. All of the logic lives in lib/agentSync.ts.
import { handleAgentSync } from "../../../../../lib/agentSync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  return handleAgentSync(req);
}
