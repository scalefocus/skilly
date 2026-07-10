// Presence page beacon (SKILLY_SPEC.md §4): any authenticated user stamps `users.last_seen_page`
// (+ `last_seen`) with a human-readable label of the page they're viewing. Uses
// `currentAccessNoStamp()` (not `currentAccess()`) so this request stamps presence exactly once,
// via the explicit `touchLastSeen(userId, label)` call below — going through `currentAccess()`
// first would stamp unlabeled and then lose the shared throttle race to itself.
import { currentAccessNoStamp } from "../../../../lib/guard";
import { touchLastSeen, sanitizePageLabel } from "../../../../lib/presence";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const access = await currentAccessNoStamp();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });

  // Best-effort: a missing/malformed/oversized label is silently ignored, never a 4xx (§4) — the
  // beacon is fire-and-forget from the client and must never surface as a UI error.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: true });
  }
  const label = sanitizePageLabel((body as { label?: unknown } | null)?.label);
  if (label) touchLastSeen(access.userId, label);
  return Response.json({ ok: true });
}
