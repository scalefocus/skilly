// Platform-admin: create an Entra-group → role mapping. SKILLY_SPEC.md §4.
import { currentAccess } from "../../../../lib/guard";
import { pool } from "../../../../lib/db";
import { createRoleMapping } from "../../../../lib/admin";
import type { Role } from "@skilly/shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const access = await currentAccess();
  if (!access?.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const body = (await req.json()) as { groupId: string; namespaceId: string | null; role: Role };
  const result = await createRoleMapping(pool, body, access.userId);
  if ("error" in result) return Response.json(result, { status: 422 });
  return Response.json(result, { status: 201 });
}
