// Server-side auth guard helpers for route handlers.
import { getServerSession } from "next-auth";
import { authOptions } from "./auth";
import { resolveUserAccess } from "./access";
import { touchLastSeen } from "./presence";

/**
 * Resolved access for the current session, or null if unauthenticated — WITHOUT the presence
 * stamp below. For callers (the `/api/presence/page` beacon, §4) that stamp presence themselves
 * with a page label: reusing `currentAccess()` there would stamp twice in the same request (once
 * here, unlabeled; once explicitly, labeled) and the labeled stamp would lose the shared throttle
 * race to itself, silently dropping every beacon.
 */
export async function currentAccessNoStamp() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return null;
  return resolveUserAccess(oid);
}

/** Resolved access for the current session, or null if unauthenticated. */
export async function currentAccess() {
  const access = await currentAccessNoStamp();
  // Presence: stamp last_seen for the "Currently online" admin view (§4). Fire-and-forget +
  // throttled inside touchLastSeen — never blocks or fails this request.
  if (access?.userId) touchLastSeen(access.userId);
  return access;
}
