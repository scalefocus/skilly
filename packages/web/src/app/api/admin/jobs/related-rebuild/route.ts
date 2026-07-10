// Admin control for the "Skills you might like" batch job (§10). Platform-admin only.
//   GET  → { lastRunAt, lastRunCount, running } for the Maintenance card.
//   POST → signal the worker to rebuild the related-skills index now (audited).
// The web tier never runs the batch itself — it flips a platform_settings flag the worker polls.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../lib/access";
import { getRelatedJobStatus, requestRelatedRebuild } from "../../../../../lib/settings";

export const dynamic = "force-dynamic";

async function requirePlatformAdmin() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return { error: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  const access = await resolveUserAccess(oid);
  if (!access.userId) return { error: Response.json({ error: "unknown user" }, { status: 403 }) };
  if (!access.isPlatformAdmin) return { error: Response.json({ error: "platform admin required" }, { status: 403 }) };
  return { userId: access.userId };
}

export async function GET() {
  const gate = await requirePlatformAdmin();
  if (gate.error) return gate.error;
  return Response.json(await getRelatedJobStatus());
}

export async function POST() {
  const gate = await requirePlatformAdmin();
  if (gate.error) return gate.error;
  await requestRelatedRebuild(gate.userId);
  return Response.json({ ok: true, running: true });
}
