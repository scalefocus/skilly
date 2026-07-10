// Nav badge counts + "mark seen" for the Catalog / Review queue / System log / Requested skills
// sidebar items.
// GET  -> { catalog, review, systemLog, requests } counts of items new since the user last opened each.
// POST { surface: "catalog" | "review" | "system-log" | "requests" } -> records a view (clears that badge).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { resolveUserAccess } from "../../../lib/access";
import { getNavBadges } from "../../../lib/navbadges";
import { markNavSeen } from "../../../lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  const badges = await getNavBadges(access);
  return Response.json(badges);
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { surface?: string };
  if (body.surface !== "catalog" && body.surface !== "review" && body.surface !== "system-log" && body.surface !== "requests") {
    return Response.json({ error: "surface must be 'catalog', 'review', 'system-log', or 'requests'" }, { status: 422 });
  }
  await markNavSeen(access.userId, body.surface);
  return Response.json({ ok: true });
}
