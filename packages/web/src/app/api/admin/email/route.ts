// Platform-admin: §12 email channel status + disconnect. SKILLY_SPEC.md §12, §15.
import { currentAccess } from "../../../../lib/guard";
import { getEmailChannelStatus, disconnectEmail } from "../../../../lib/email";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access?.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  return Response.json(await getEmailChannelStatus());
}

export async function DELETE() {
  const access = await currentAccess();
  if (!access?.userId || !access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const upn = await disconnectEmail(access.userId);
  if (!upn) return Response.json({ error: "no email service account is connected" }, { status: 404 });
  return Response.json({ ok: true, disconnected: upn });
}
