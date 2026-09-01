// Read/write one namespace's settings — `require_review`, `maintainer_contact`, and the Claude
// plugin marketplace toggle (SKILLY_SPEC.md §30.6). Namespace admin for their own namespace, or
// platform admin for any. The Administration → Namespaces card writes through the same lib, so
// the two surfaces validate and audit identically.
import { currentAccess } from "../../../../../lib/guard";
import { listAdministeredNamespaces, updateNamespaceSettings } from "../../../../../lib/namespaceAdmin";
import { getMarketplaceNamePrefix } from "../../../../../lib/settings";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const id = (await ctx.params).id;
  if (!UUID.test(id)) return Response.json({ error: "not found" }, { status: 404 });

  const prefix = await getMarketplaceNamePrefix();
  // Reuse the list query so a caller can only ever read a namespace they administer — an
  // unadministered (or nonexistent) id is indistinguishable, both 404.
  const view = (await listAdministeredNamespaces(access, prefix)).find((n) => n.id === id);
  if (!view) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ namespace: view });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const id = (await ctx.params).id;
  if (!UUID.test(id)) return Response.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    requireReview?: unknown;
    maintainerContact?: unknown;
    marketplaceEnabled?: unknown;
  };

  const patch: Parameters<typeof updateNamespaceSettings>[2] = {};
  if (typeof body.requireReview === "boolean") patch.requireReview = body.requireReview;
  if (typeof body.marketplaceEnabled === "boolean") patch.marketplaceEnabled = body.marketplaceEnabled;
  if (body.maintainerContact === null || typeof body.maintainerContact === "string") {
    patch.maintainerContact = body.maintainerContact as string | null;
  }
  if (Object.keys(patch).length === 0) return Response.json({ error: "nothing to update" }, { status: 422 });

  const prefix = await getMarketplaceNamePrefix();
  const result = await updateNamespaceSettings(access, id, patch, access.userId, prefix);
  if (!result.ok) {
    // A namespace the caller may not administer is reported as 404, not 403 — the response must
    // not confirm that a namespace they can't see exists (invariant #3).
    const status = result.status === 403 ? 404 : result.status;
    return Response.json({ error: status === 404 ? "not found" : result.error }, { status });
  }
  return Response.json({ namespace: result.view, tokensRevoked: result.tokensRevoked });
}
