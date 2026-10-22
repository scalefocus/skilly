// Suggest a feature (SKILLY_SPEC.md §60.4). POST { description } → 201 { idea } · 422 bad length ·
// 429 { reason: "pending_limit" | "daily_limit" } at a cap (the daily one with Retry-After) · 404 off.
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
  const r = await submitIdea(caller.viewer.userId, body.description);
  if (r.ok) return Response.json({ idea: r.idea }, { status: 201 });
  if (r.status === 422) return Response.json({ error: r.error }, { status: 422 });
  return Response.json(
    { error: IDEA_LIMIT_MESSAGES[r.reason], reason: r.reason },
    { status: 429, headers: r.retryAfterSeconds != null ? { "retry-after": String(r.retryAfterSeconds) } : undefined },
  );
}
