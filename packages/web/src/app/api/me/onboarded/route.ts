// Marks the signed-in user as having seen the Quick start onboarding page. Called once, on the
// Quick start page's mount, so the first-login redirect gate (AppShell) releases and never fires
// again for this user. Idempotent: only stamps when still null, so a re-view never moves the date.
// SKILLY_SPEC.md §8 (Quick start).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { pool } from "../../../../lib/db";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  const { rows } = await pool.query<{ onboarded_at: string }>(
    `update users set onboarded_at = coalesce(onboarded_at, now()) where id = $1 returning onboarded_at`,
    [access.userId],
  );
  return Response.json({ ok: true, onboardedAt: rows[0]?.onboarded_at ?? null });
}
