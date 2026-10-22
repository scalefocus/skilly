// Suggest a feature (SKILLY_SPEC.md §60.4). POST { description } → 201 { idea } · 422 bad length ·
// 403 { reason: "suggestions_off" } for a caller who is not a platform admin while the switch is off ·
// 429 { reason: "pending_limit" | "daily_limit" } at a cap (the daily one with Retry-After).
import { submitIdea } from "../../../../lib/ideas";
import { ideasCaller, jsonBody } from "../../../../lib/ideasRoute";
import { enforceRateLimit } from "../../../../lib/ratelimit";
import { IDEA_LIMIT_MESSAGES } from "@skilly/shared/ideas";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const caller = await ideasCaller();
  if (!caller.ok) return caller.res;
  const limited = enforceRateLimit("idea-write", caller.viewer.userId, 30);
  if (limited) return limited;
  const body = await jsonBody(req);
  const r = await submitIdea(caller.viewer, body.description);
  if (r.ok) return Response.json({ idea: r.idea }, { status: 201 });
  if (r.status === 403) return Response.json({ error: "Only platform admins can suggest features right now.", reason: r.reason }, { status: 403 });
  if (r.status === 422) return Response.json({ error: r.error }, { status: 422 });
  return Response.json(
    { error: IDEA_LIMIT_MESSAGES[r.reason], reason: r.reason },
    { status: 429, headers: r.retryAfterSeconds != null ? { "retry-after": String(r.retryAfterSeconds) } : undefined },
  );
}
