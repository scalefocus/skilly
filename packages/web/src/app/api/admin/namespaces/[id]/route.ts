// Platform-admin: update a namespace (review policy / maintainer / plugin marketplace / review
// target). SKILLY_SPEC.md §4, §30.6, §75.5.
//
// The marketplace toggle and the review target are settings namespace admins also write, on
// /namespaces — so those two delegate to the same lib/namespaceAdmin writer rather than duplicating
// the token revocation, the validation and the audit entry (see patchNamespaceFromAdministration).
import { currentAccess } from "../../../../../lib/guard";
import { pool } from "../../../../../lib/db";
import { patchNamespaceFromAdministration, type AdminNamespacePatch } from "../../../../../lib/admin";
import { deleteNamespace } from "../../../../../lib/namespaceDelete";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const id = (await ctx.params).id;
  const body = (await req.json()) as AdminNamespacePatch;
  const result = await patchNamespaceFromAdministration(pool, access, id, body, access.userId);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true, ...(result.tokensRevoked !== undefined ? { tokensRevoked: result.tokensRevoked } : {}) });
}

// Platform-admin: permanently delete an EMPTY namespace (SKILLY_SPEC.md §72.9). Body
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
