// Real-user-monitoring beacon (SKILLY_SPEC.md §32.5). Any signed-in user posts batches of their
// own browser's samples; a signed-out caller gets a silent 401 the client ignores (same posture as
// the presence beacon, §4). The trust boundary is `parseRumBatch`: fixed enums, bounded numbers,
// templated routes only, all-or-nothing per batch, and `created_at` is server-stamped.
//
// Deliberately answers 400 (not 422) to a malformed batch and is NOT wrapped in withSystemLog:
// 400 sits outside the System log's recorded 4xx set (§25), so a misbehaving tab can never flood
// the log. Uses currentAccessNoStamp() so RUM traffic — which also flushes from hidden tabs —
// never inflates presence.
import { currentAccessNoStamp } from "../../../lib/guard";
import { enforceRateLimit } from "../../../lib/ratelimit";
import { getRumSettings } from "../../../lib/settings";
import { parseRumBatch, RUM_MAX_BODY_BYTES, RUM_RATE_LIMIT_PER_MINUTE } from "../../../lib/rum/validate";
import { insertRumSamples } from "../../../lib/rum/queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const access = await currentAccessNoStamp();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const limited = enforceRateLimit("rum", access.userId, RUM_RATE_LIMIT_PER_MINUTE);
  if (limited) return limited;

  // Fast reject by declared length; the read below is the authoritative cap.
  if (Number(req.headers.get("content-length") ?? "0") > RUM_MAX_BODY_BYTES) return Response.json({ error: "batch too large" }, { status: 400 });
  const raw = await req.text();
  if (raw.length > RUM_MAX_BODY_BYTES) return Response.json({ error: "batch too large" }, { status: 400 });

  // Collection off → accept-and-discard, so a tab that hasn't re-read the flag yet never errors.
  const { enabled } = await getRumSettings();
  if (!enabled) return new Response(null, { status: 204 });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = parseRumBatch(body);
  if (!parsed.ok) return Response.json({ error: parsed.reason }, { status: 400 });

  await insertRumSamples(access.userId, parsed.samples);
  return new Response(null, { status: 204 });
}
