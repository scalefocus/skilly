// Platform-admin: send a §12 test email (current wrapper + sample message) to the acting
// admin's own address. Requires the Graph transport operational. Unaudited — mails only
// the actor.
import { currentAccess } from "../../../../../lib/guard";
import { sendTestEmail } from "../../../../../lib/email";

export const dynamic = "force-dynamic";

export async function POST() {
  const access = await currentAccess();
  if (!access?.userId || !access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const r = await sendTestEmail(access.userId);
  if ("error" in r) return Response.json({ error: r.error }, { status: 422 });
  return Response.json(r);
}
