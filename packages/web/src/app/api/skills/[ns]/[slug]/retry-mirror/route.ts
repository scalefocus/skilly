// Retry a dead-lettered pointer mirror (SKILLY_SPEC.md §6). PLATFORM ADMIN ONLY: resets the
// skill's failed pending_mirrors row(s) — attempts → 0, last_error → null — so the leader worker's
// next sweep makes up to MIRROR_MAX_ATTEMPTS (default 5) fresh attempts at the SAME pinned
// ref/URL/subdir. No new proposal/version is created. Audited as `skill.mirror_retry`.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { findSkill } from "../../../../../../lib/catalog";
import { pool } from "../../../../../../lib/db";
import { appendAudit } from "../../../../../../lib/audit";
import { withSystemLog } from "../../../../../../lib/apiLog";

export const dynamic = "force-dynamic";

const MAX_MIRROR_ATTEMPTS = Number(process.env.MIRROR_MAX_ATTEMPTS ?? 5);

export const POST = withSystemLog("/api/skills/[ns]/[slug]/retry-mirror", async function POST(_req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  // Global (platform) admin only — this re-arms background work and is a governance action.
  if (!access.isPlatformAdmin) return Response.json({ error: "platform admin required" }, { status: 403 });

  const { ns, slug } = await ctx.params;
  const skill = await findSkill(ns, slug);
  if (!skill) return Response.json({ error: "not found" }, { status: 404 });

  // Only re-arm rows that have actually dead-lettered (attempts at the cap); a still-pending
  // mirror needs no retry. Resetting clears the recorded error so the UI flips back to "Mirroring…".
  const { rows } = await pool.query<{ semver: string }>(
    `update pending_mirrors set attempts = 0, last_error = null
      where skill_id = $1 and attempts >= $2
      returning semver`,
    [skill.id, MAX_MIRROR_ATTEMPTS],
  );
  if (rows.length === 0) {
    // Nothing dead-lettered (already retried, or the mirror has since succeeded/been removed).
    return Response.json({ error: "no failed mirror to retry for this skill" }, { status: 409 });
  }

  const semvers = rows.map((r) => r.semver);
  await appendAudit(pool, {
    actorUserId: access.userId,
    action: "skill.mirror_retry",
    targetType: "skill",
    targetId: skill.id,
    namespaceId: skill.namespaceId,
    after: { semvers, attempts: 0 },
  });
  return Response.json({ ok: true, retried: semvers });
});
