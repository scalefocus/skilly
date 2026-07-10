// Platform-admin: set/clear the header system banner. SKILLY_SPEC.md §27.
import { currentAccess } from "../../../../lib/guard";
import { getSystemBanner, setSystemBanner, clearSystemBanner } from "../../../../lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access?.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  return Response.json(await getSystemBanner());
}

export async function PUT(req: Request) {
  const access = await currentAccess();
  if (!access?.userId || !access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { message?: string; durationHours?: number };
  if (typeof body.message !== "string" || typeof body.durationHours !== "number") {
    return Response.json({ error: "message and durationHours are required" }, { status: 422 });
  }
  try {
    return Response.json(await setSystemBanner(body.message, body.durationHours, access.userId));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "invalid system message" }, { status: 422 });
  }
}

export async function DELETE() {
  const access = await currentAccess();
  if (!access?.userId || !access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  await clearSystemBanner(access.userId);
  return Response.json({ ok: true });
}
