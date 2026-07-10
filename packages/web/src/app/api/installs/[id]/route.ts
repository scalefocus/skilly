// Uninstall (DELETE) or reactivate (PATCH) an install. Personal rows are owner-scoped; SYSTEM
// rows (§23 "System installations") are managed by ANY platform admin instead, and both actions
// on them are audited (install.system_uninstalled / install.system_reactivated).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { uninstall, reactivate, uninstallSystem, reactivateSystem, getInstallMeta } from "../../../../lib/installs";
import { getInstallMaxTtlMonths, installExpiryCeiling } from "../../../../lib/settings";
import { appendAudit } from "../../../../lib/audit";
import { pool } from "../../../../lib/db";
import type { EffectiveAccess } from "@skilly/shared";

export const dynamic = "force-dynamic";

async function requireAccess(): Promise<(EffectiveAccess & { userId: string | null }) | null> {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return null;
  return resolveUserAccess(oid);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await requireAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const id = (await ctx.params).id;

  const meta = await getInstallMeta(id);
  if (meta?.isSystem) {
    // System installs are platform-admin-managed (any admin, not just the minter). Non-admins get
    // the same 404 as a missing row — no existence oracle.
    if (!access.isPlatformAdmin) return Response.json({ error: "not found" }, { status: 404 });
    const ok = await uninstallSystem(id);
    if (!ok) return Response.json({ error: "not found" }, { status: 404 });
    await appendAudit(pool, {
      actorUserId: access.userId,
      action: "install.system_uninstalled",
      targetType: "skill",
      targetId: meta.skillId,
      namespaceId: meta.namespaceId,
      before: { skill: meta.skillRef, semver: meta.pinnedSemver ?? "latest", expiresAt: meta.expiresAt ?? "never" },
    });
    return Response.json({ ok: true });
  }

  const ok = await uninstall(access.userId, id);
  if (!ok) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ok: true });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await requireAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const id = (await ctx.params).id;

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

  const meta = await getInstallMeta(id);
  if (meta?.isSystem) {
    if (!access.isPlatformAdmin) return Response.json({ error: "not found" }, { status: 404 });
    // reactivateSystem only matches currently-inactive (used + expired) system rows.
    const ok = await reactivateSystem(id, expiresAt);
    if (!ok) return Response.json({ error: "not found or not inactive" }, { status: 404 });
    await appendAudit(pool, {
      actorUserId: access.userId,
      action: "install.system_reactivated",
      targetType: "skill",
      targetId: meta.skillId,
      namespaceId: meta.namespaceId,
      before: { skill: meta.skillRef, expiresAt: meta.expiresAt ?? "never" },
      after: { expiresAt: expiresAt?.toISOString() ?? "never" },
    });
    return Response.json({ ok: true });
  }

  // reactivate only matches currently-inactive (used + expired) rows owned by the caller.
  const ok = await reactivate(access.userId, id, expiresAt);
  if (!ok) return Response.json({ error: "not found or not inactive" }, { status: 404 });
  return Response.json({ ok: true });
}
