// Platform-admin: list users currently online (active within the presence window). §4.
import { currentAccess } from "../../../../../lib/guard";
import { listOnlineUsers, countOnlineUsers, getActiveUserCounts, ONLINE_WINDOW_MINUTES, ONLINE_WINDOW_OPTIONS } from "../../../../../lib/presence";

export const dynamic = "force-dynamic";

const PAGE = 100;

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const url = new URL(req.url);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const limit = Math.min(PAGE, Math.max(1, Number(url.searchParams.get("limit") ?? PAGE) || PAGE));
  const q = (url.searchParams.get("q") ?? "").trim() || undefined;
  // "Online" window (§4): only the fixed option set is accepted — never an arbitrary client interval.
  const winRaw = Number(url.searchParams.get("window"));
  const windowMins = (ONLINE_WINDOW_OPTIONS as readonly number[]).includes(winRaw) ? winRaw : ONLINE_WINDOW_MINUTES;

  // DAU/WAU/MAU (§4) piggyback on this same poll (the admin page's "Currently online" card
  // already refreshes every 60s) rather than a second endpoint/round trip — they're unrelated to
  // the search/pagination/window params above and always reflect the platform-wide total.
  const [users, total, active] = await Promise.all([listOnlineUsers(offset, limit, q, windowMins), countOnlineUsers(q, windowMins), getActiveUserCounts()]);
  return Response.json({ users, total, hasMore: offset + users.length < total, ...active });
}
