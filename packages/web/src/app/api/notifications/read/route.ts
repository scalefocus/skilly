// Mark notifications read: { ids: [...] } for specific rows, or { all: true } for everything.
import { currentAccess } from "../../../../lib/guard";
import { markRead } from "../../../../lib/notifications";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { ids?: string[]; all?: boolean };
  const updated = await markRead(access.userId, body.all ? undefined : body.ids ?? []);
  return Response.json({ ok: true, updated });
}
