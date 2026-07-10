// Platform-admin: save the §12 HTML message wrapper. Sanitized server-side; save is
// rejected unless the literal [SYSTEM MESSAGE] placeholder appears exactly once. Audited.
import { currentAccess } from "../../../../../lib/guard";
import { saveEmailWrapper } from "../../../../../lib/email";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  const access = await currentAccess();
  if (!access?.userId || !access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { html?: string };
  if (typeof body.html !== "string") return Response.json({ error: "html is required" }, { status: 422 });
  const r = await saveEmailWrapper(body.html, access.userId);
  if ("error" in r) return Response.json({ error: r.error }, { status: 422 });
  return Response.json({ ok: true, sanitized: r.sanitized });
}
