// In-app notification inbox for the signed-in user.
import { currentAccess } from "../../../lib/guard";
import { listNotifications, unreadCount, pruneNotifications } from "../../../lib/notifications";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.userId) return Response.json({ items: [], unread: 0 });
  const url = new URL(req.url);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  // ?types=a,b,c — multi-select event-type filter (validated as simple dotted slugs).
  const types = (url.searchParams.get("types") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => /^[a-z_]+\.[a-z_]+$/.test(t))
    .slice(0, 20);
  // Bound storage: when the inbox is loaded, keep only the most recent 1000 per user and
  // delete the rest (§12). Runs on the first page / unread poll, concurrently with the reads —
  // the newest page is never pruned, so it can't race; a no-op for users under the cap.
  const reads = Promise.all([
    listNotifications(access.userId, 100, offset, types.length ? types : undefined),
    unreadCount(access.userId),
  ]);
  if (offset === 0) await pruneNotifications(access.userId).catch(() => {});
  const [items, unread] = await reads;
  return Response.json({ items, unread });
}
