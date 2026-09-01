// Remove (DELETE) or reactivate (PATCH) one added marketplace. Owner-scoped throughout —
// marketplace tokens are always personal (system marketplaces are deferred, §30.4), so unlike
// /api/installs/[id] there is no platform-admin branch here.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../lib/access";
import { removeMarketplace, reactivateMarketplace } from "../../../../../lib/marketplaces";
import { getInstallMaxTtlMonths, installExpiryCeiling } from "../../../../../lib/settings";

export const dynamic = "force-dynamic";

async function requireUser(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return null;
  return (await resolveUserAccess(oid)).userId ?? null;
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await requireUser();
  if (!userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const ok = await removeMarketplace(userId, (await ctx.params).id);
  if (!ok) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await requireUser();
  if (!userId) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { expiresAt?: string | null };
  let expiresAt: Date | null = null;
  if (body.expiresAt) {
    const d = new Date(body.expiresAt);
    if (Number.isNaN(d.getTime())) return Response.json({ error: "invalid expiry date" }, { status: 422 });
    if (d.getTime() <= Date.now()) return Response.json({ error: "expiry must be in the future" }, { status: 422 });
    const months = await getInstallMaxTtlMonths();
    if (d.getTime() > installExpiryCeiling(months).getTime()) {
      return Response.json({ error: `expiry can be at most ${months} month${months === 1 ? "" : "s"} out — or choose “Never”` }, { status: 422 });
    }
    expiresAt = d;
  }

  // Only matches currently-inactive (used + expired) rows owned by the caller, so the SAME token
  // comes back to life and their existing URL keeps working — no re-add in Claude Code (§30.6).
  const ok = await reactivateMarketplace(userId, (await ctx.params).id, expiresAt);
  if (!ok) return Response.json({ error: "not found or not inactive" }, { status: 404 });
  return Response.json({ ok: true });
}
