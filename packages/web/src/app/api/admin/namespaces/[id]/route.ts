// Platform-admin: update a namespace (review policy / maintainer / plugin marketplace).
// SKILLY_SPEC.md §4, §30.6.
//
// The marketplace toggle is a DUAL surface — namespace admins flip it on /namespaces, platform
// admins from here — so it delegates to the same lib/namespaceAdmin writer rather than duplicating
// the token revocation and the audit entry.
import { currentAccess } from "../../../../../lib/guard";
import { pool } from "../../../../../lib/db";
import { updateNamespace } from "../../../../../lib/admin";
import { updateNamespaceSettings } from "../../../../../lib/namespaceAdmin";
import { deleteNamespace } from "../../../../../lib/namespaceDelete";
import { getMarketplaceNamePrefix } from "../../../../../lib/settings";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const id = (await ctx.params).id;
  const body = (await req.json()) as { requireReview?: boolean; maintainerContact?: string | null; marketplaceEnabled?: boolean };

  if (typeof body.marketplaceEnabled === "boolean") {
    const prefix = await getMarketplaceNamePrefix();
    const result = await updateNamespaceSettings(access, id, { marketplaceEnabled: body.marketplaceEnabled }, access.userId, prefix);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ ok: true, tokensRevoked: result.tokensRevoked });
  }

  const err = await updateNamespace(pool, id, body, access.userId);
  if (err) return Response.json(err, { status: 422 });
  return Response.json({ ok: true });
}

// Platform-admin: permanently delete an EMPTY namespace (SKILLY_SPEC.md §71.9). Body
// `{ confirmSlug, reason? }`; 409 `namespace_not_empty` carries the blocker lists.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const id = (await ctx.params).id;
  const body = (await req.json().catch(() => ({}))) as { confirmSlug?: unknown; reason?: unknown };
  const result = await deleteNamespace(pool, id, { confirmSlug: body.confirmSlug, reason: body.reason }, access.userId);
  if (!result.ok) {
    const { status, ...rest } = result;
    return Response.json(rest, { status });
  }
  return Response.json({ ok: true, effects: result.effects });
}
