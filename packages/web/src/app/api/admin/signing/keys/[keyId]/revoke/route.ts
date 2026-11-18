// Revoke a platform signing key (SKILLY_SPEC.md §73.9): final, needs a reason, audited as
// signing.key_revoked. Every statement the key signed then reads `revoked_key` until the worker's
// re-sign sweep replaces it. Platform admins only; 409 when already revoked.
import { currentAccess } from "../../../../../../../lib/guard";
import { withSystemLog } from "../../../../../../../lib/apiLog";
import { revokeSigningKey } from "../../../../../../../lib/signing";

export const dynamic = "force-dynamic";

export const POST = withSystemLog(
  "/api/admin/signing/keys/[keyId]/revoke",
  async function POST(req: Request, ctx: { params: Promise<{ keyId: string }> }) {
    const access = await currentAccess();
    if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
    if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });
    const { keyId } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { reason?: unknown } | null;
    const r = await revokeSigningKey(access.userId, keyId, body?.reason);
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
    return Response.json({ ok: true, statementsAffected: r.affected });
  },
);
