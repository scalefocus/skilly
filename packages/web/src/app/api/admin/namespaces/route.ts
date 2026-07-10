// Platform-admin: list config + create namespaces. SKILLY_SPEC.md §4.
import { currentAccess } from "../../../../lib/guard";
import { pool } from "../../../../lib/db";
import { getAdminConfig, createNamespace, listNamespacePage, countNamespaces } from "../../../../lib/admin";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const access = await currentAccess();
  if (!access) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const url = new URL(req.url);
  // ?offset / ?q / ?review / ?list=1 → just a slug-ordered page of namespaces with the
  // filtered total (admin search + infinite scroll). Otherwise the full config with the
  // first page; ?nsLimit lets the page re-fetch everything it has already loaded in one
  // request after a mutation.
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const q = (url.searchParams.get("q") ?? "").trim() || undefined;
  const reviewParam = url.searchParams.get("review");
  const review = reviewParam === "required" ? true : reviewParam === "optional" ? false : undefined;
  if (offset > 0 || q !== undefined || review !== undefined || url.searchParams.get("list") === "1") {
    const [namespaces, namespacesTotal] = await Promise.all([
      listNamespacePage(pool, offset, undefined, q, review),
      countNamespaces(pool, q, review),
    ]);
    return Response.json({ namespaces, namespacesTotal });
  }
  const nsLimit = Number(url.searchParams.get("nsLimit") ?? 0) || undefined;
  return Response.json(await getAdminConfig(pool, nsLimit));
}

export async function POST(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const body = (await req.json()) as { slug: string; displayName: string; requireReview?: boolean; maintainerContact?: string };
  const result = await createNamespace(
    pool,
    { slug: body.slug, displayName: body.displayName, requireReview: body.requireReview ?? true, maintainerContact: body.maintainerContact ?? null },
    access.userId,
  );
  if ("error" in result) return Response.json(result, { status: 422 });
  return Response.json(result, { status: 201 });
}
