// Administration → Signing (SKILLY_SPEC.md §73.8): keys, statement counts, unsigned and re-sign
// backlog, recent mismatch reports. Platform admins only.
import { currentAccess } from "../../../../lib/guard";
import { signingAdminView } from "../../../../lib/signing";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  return Response.json(await signingAdminView());
}
