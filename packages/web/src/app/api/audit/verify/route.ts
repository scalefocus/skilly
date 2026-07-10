// Verify the tamper-evident audit hash chain. Platform admins only (whole-chain integrity).
import { currentAccess } from "../../../../lib/guard";
import { verifyAuditChain } from "../../../../lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
  return Response.json(await verifyAuditChain());
}
